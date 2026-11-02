import type { ExtensionAPI, ExtensionContext, SessionModeState } from "@oh-my-pi/pi-coding-agent";
import DiscordRPC from "discord-rpc";
// Resolved by omp's loader to the running host, so this is the installed omp version, not a bundled copy.
import { VERSION } from "@oh-my-pi/pi-utils";
import { execFile, spawn } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { createConnection, createServer, type Server } from "node:net";
import { homedir, release } from "node:os";
import { basename, dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { MODEL_ICON_RULES, PROVIDER_ICON_RULES, type IconRule } from "./model-icons.generated.ts";
import { promisify } from "node:util";

const CLIENT_ID = process.env.OMP_DISCORD_CLIENT_ID ?? "1566329796068384808";
const LARGE_IMAGE_KEY = process.env.OMP_DISCORD_LARGE_IMAGE_KEY;
// Lobe-icons rules (see scripts/sync-model-icons.ts); keys are Discord Art Assets uploaded from assets/models/.
const compileIconRules = (rules: readonly IconRule[]) =>
	rules.map(([keywords, key]) => [keywords.map((keyword) => new RegExp(keyword, "i")), key] as const);
const MODEL_ICONS = compileIconRules(MODEL_ICON_RULES);
const PROVIDER_ICONS = compileIconRules(PROVIDER_ICON_RULES);

/** The logo key for a model: lobe's first model rule hit, else the provider rule (Claude via Copilot stays Claude). */
const modelIconKey = (model: { provider: string; id: string }): string | undefined => {
	const hit = (rules: typeof MODEL_ICONS, value: string) => rules.find(([patterns]) => patterns.some((p) => p.test(value)));
	return (hit(MODEL_ICONS, model.id.toLowerCase()) ?? hit(PROVIDER_ICONS, model.provider.toLowerCase()))?.[1] ?? undefined;
};
const GLOBAL_STATE_FILE = join(homedir(), ".omp", "agent", "discord-presence-state.json");
const RECONNECT_DELAY_MS = 15_000;
const MODEL_POLL_MS = 3_000;
const PRESENCE_UPDATE_DEBOUNCE_MS = 750;
// Discord accepts at most 5 activity updates per 20 s; more are acknowledged but may never render,
// which can leave a stale "using tool" on screen. Space updates out and always send the latest state.
const MIN_PRESENCE_UPDATE_INTERVAL_MS = 4_000;
const DISCORD_TEXT_LIMIT = 128;
const PRIVATE_PROJECT_LABEL = "private project";

type PresenceStatus = "idle" | "away" | "working" | "tool" | "waiting" | "compacting" | "retrying" | "offline";

const STATUS_LABELS: Record<PresenceStatus, string> = {
	idle: "idle",
	working: "thinking",
	tool: "using tool",
	compacting: "compacting context",
	retrying: "retrying",
	away: "away",
	waiting: "waiting for",
	offline: "starting",
};

type PresenceState = {
	status: PresenceStatus;
	/** Shown after the status label: the tool name, or the retry attempt. */
	detail?: string;
	model?: { provider: string; id: string };
	/** Context-window usage in whole percent; only shown when showContext is on. */
	contextPercent?: number;
	startedAt: number;
};

type GlobalState = {
	enabled: boolean;
	/** Absolute project paths whose name is never sent to Discord (subdirectories included). */
	hiddenProjects: string[];
	/** Opt-in: append context-window usage to the status. */
	showContext: boolean;
	/** Show the model, its effort and its logo. */
	showModel: boolean;
	/** Show the "View on GitHub" button for public repos. */
	showButton: boolean;
	/** Minutes idle before the status turns "away"; 0 never. */
	awayMinutes: number;
	/** Show "private project" when origin is a private (or unverifiable) GitHub repo. */
	autoHidePrivate: boolean;
};

const DEFAULT_STATE: GlobalState = {
	enabled: true,
	hiddenProjects: [],
	showContext: false,
	showModel: true,
	showButton: true,
	awayMinutes: 15,
	autoHidePrivate: true,
};

type DiscordRpcClient = DiscordRPC.Client & {
	clearActivity?: () => Promise<void> | void;
	destroy?: () => void;
};

const truncateDiscordText = (value: string): string => {
	if (value.length <= DISCORD_TEXT_LIMIT) return value;
	return `${value.slice(0, DISCORD_TEXT_LIMIT - 1)}…`;
};

const normalizeProjectName = (cwd: string): string => {
	const parts = cwd.split(/[\\/]/).filter(Boolean);
	return parts.at(-1) ?? "omp session";
};

const isProjectHidden = (cwd: string, hiddenProjects: string[]): boolean =>
	hiddenProjects.some((project) => cwd === project || cwd.startsWith(project.endsWith(sep) ? project : project + sep));

const readGlobalState = (): GlobalState => {
	try {
		const parsed = JSON.parse(readFileSync(GLOBAL_STATE_FILE, "utf8")) as Partial<Record<keyof GlobalState, unknown>>;
		const awayMinutes = parsed.awayMinutes;
		return {
			enabled: parsed.enabled !== false,
			hiddenProjects: Array.isArray(parsed.hiddenProjects)
				? parsed.hiddenProjects.filter((project): project is string => typeof project === "string")
				: [],
			showContext: parsed.showContext === true,
			showModel: parsed.showModel !== false,
			showButton: parsed.showButton !== false,
			autoHidePrivate: parsed.autoHidePrivate !== false,
			awayMinutes:
				typeof awayMinutes === "number" && Number.isFinite(awayMinutes) && awayMinutes >= 0
					? awayMinutes
					: DEFAULT_STATE.awayMinutes,
		};
	} catch {
		return { ...DEFAULT_STATE };
	}
};

/** "plan mode + goal mode (paused)"; the goal objective and plan path stay private. */
const formatModes = (state: SessionModeState | undefined): string =>
	state
		? (["plan", "goal", "loop", "vibe"] as const)
				.filter((mode) => state[mode].status !== "inactive")
				.map((mode) => `${mode} mode${state[mode].status === "paused" ? " (paused)" : ""}`)
				.join(" + ")
		: "";

const writeGlobalState = (patch: Partial<GlobalState>): GlobalState => {
	const next = { ...readGlobalState(), ...patch };
	mkdirSync(dirname(GLOBAL_STATE_FILE), { recursive: true });
	// Write-then-rename so concurrent sessions never read a half-written file (and briefly leak hidden names).
	const tmp = `${GLOBAL_STATE_FILE}.${process.pid}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
	renameSync(tmp, GLOBAL_STATE_FILE);
	return next;
};

/** Public application info (no auth): the name Discord shows as the activity title, and its icon. */
const fetchAppInfo = async (): Promise<{ name?: string; iconUrl?: string }> => {
	try {
		const response = await fetch(`https://discord.com/api/v10/applications/${CLIENT_ID}/rpc`);
		const app = (await response.json()) as { name?: string; icon?: string | null };
		return {
			name: app.name,
			iconUrl: app.icon ? `https://cdn.discordapp.com/app-icons/${CLIENT_ID}/${app.icon}.png?size=512` : undefined,
		};
	} catch {
		return {};
	}
};

const execFileAsync = promisify(execFile);
// Captures owner/repo from https, ssh and scp-style remotes; credentials before the host are never captured.
const GITHUB_REMOTE = /github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/;

/**
 * `mayBePrivate`: origin is on GitHub but not publicly visible: a 404 (private, or deleted) or an
 * unverifiable answer (offline, rate limit). Auto-hide fails closed on both so a private name never leaks.
 */
type RepoLookup = { url: string; slug: string } | { reason: string; mayBePrivate?: true };

const LOOKUP_TIMEOUT_MS = 5_000;

/** The public GitHub URL of cwd's `origin` remote, or why there is none. */
const findPublicGithubRepo = async (cwd: string): Promise<RepoLookup> => {
	let slug: string | undefined;
	try {
		const { stdout } = await execFileAsync("git", ["-C", cwd, "remote", "get-url", "origin"], {
			timeout: LOOKUP_TIMEOUT_MS,
		});
		slug = GITHUB_REMOTE.exec(stdout.trim())?.[1];
	} catch {
		return { reason: "no git origin remote" };
	}
	// shortcut: ssh host aliases (git@github-work:owner/repo) aren't recognized; resolve them via `ssh -G` if users need it.
	if (!slug) return { reason: "origin is not on GitHub" };
	try {
		// Only link public repos: a private repo's URL would leak its owner/name to everyone viewing the profile.
		const response = await fetch(`https://api.github.com/repos/${slug}`, {
			headers: { "User-Agent": "omp-discord-presence" },
			signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
		});
		if (response.ok) return { url: `https://github.com/${slug}`, slug };
		return response.status === 404
			? { reason: "private GitHub repo", mayBePrivate: true }
			: { reason: `GitHub API HTTP ${response.status}, visibility unknown`, mayBePrivate: true };
	} catch {
		return { reason: "GitHub API unreachable, visibility unknown", mayBePrivate: true };
	}
};

/** Asset keys uploaded to the Discord application; undefined when Discord can't be reached. */
const fetchUploadedAssets = async (): Promise<Set<string> | undefined> => {
	try {
		const response = await fetch(`https://discord.com/api/v10/oauth2/applications/${CLIENT_ID}/assets`);
		if (!response.ok) return undefined;
		return new Set(((await response.json()) as { name: string }[]).map((asset) => asset.name));
	} catch {
		return undefined;
	}
};

const formatDuration = (ms: number): string => {
	const seconds = Math.round(ms / 1000); // round once so "14m 60s" can't happen
	return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
};

// WSL: Discord runs on Windows and only exposes a named pipe, so serve the Unix socket discord-rpc looks for
// and relay each connection through the bundled npiperelay.exe. Path logic mirrors discord-rpc's ipc transport.
const IS_WSL = process.platform === "linux" && (!!process.env.WSL_DISTRO_NAME || /microsoft/i.test(release()));
const { XDG_RUNTIME_DIR, TMPDIR, TMP, TEMP } = process.env;
const IPC_SOCKET_PATH = join(XDG_RUNTIME_DIR || TMPDIR || TMP || TEMP || "/tmp", "discord-ipc-0");
const NPIPERELAY_PATH = fileURLToPath(new URL("../bin/npiperelay.exe", import.meta.url));
// shortcut: only Discord's first pipe (stable client); add -1..-9 fallbacks if PTB/Canary users need it.
const WINDOWS_DISCORD_PIPE = "//./pipe/discord-ipc-0";

const canConnect = (path: string): Promise<boolean> => {
	const { promise, resolve } = Promise.withResolvers<boolean>();
	const probe = createConnection(path);
	probe.once("connect", () => {
		probe.destroy();
		resolve(true);
	});
	probe.once("error", () => resolve(false));
	return promise;
};

/** Starts the WSL relay unless something (native Discord, a user's socat relay, another session) already serves the socket. */
const startWslBridge = async (): Promise<Server | undefined> => {
	if (!IS_WSL || (await canConnect(IPC_SOCKET_PATH))) return undefined;

	rmSync(IPC_SOCKET_PATH, { force: true }); // stale socket left by a crashed session
	try {
		chmodSync(NPIPERELAY_PATH, 0o755); // package managers may drop the exec bit; WSL interop needs it
	} catch {
		// Missing binary surfaces as a spawn error below.
	}

	const server = createServer((socket) => {
		// -ei: exit when omp's end closes (even if omp crashed), so Discord drops the activity instead of keeping a stale one.
		const relay = spawn(NPIPERELAY_PATH, ["-ep", "-ei", "-s", WINDOWS_DISCORD_PIPE], { stdio: ["pipe", "pipe", "ignore"] });
		// Every stream gets an error handler: an unhandled 'error' event would crash the whole omp session.
		relay.on("error", () => socket.destroy());
		relay.on("exit", () => socket.destroy());
		relay.stdin.on("error", () => socket.destroy());
		socket.on("error", () => relay.kill());
		socket.on("close", () => relay.kill());
		socket.pipe(relay.stdin);
		relay.stdout.pipe(socket);
	});
	server.unref();

	const { promise, resolve } = Promise.withResolvers<Server | undefined>();
	server.once("listening", () => resolve(server));
	server.once("error", () => resolve(undefined)); // e.g. another session won the race; its socket works too
	server.listen(IPC_SOCKET_PATH);
	return promise;
};

const USAGE = "usage: /discord-presence [settings|status|on|off|refresh|hide|show|context on|context off]";
const SHOW_PRIVATE_HINT =
	"this project is hidden because its GitHub repo is private (or its visibility can't be checked); turn off \"Auto-hide private repos\" in /discord-presence settings to show it.";

// Subagent sessions run in this process with rebound copies of this factory, so they share this module.
// Each one reports while its agent loop runs (nested subagents included); the main session displays the total.
let runningSubagents = 0;
const subagentListeners = new Set<() => void>();
const changeRunningSubagents = (delta: 1 | -1) => {
	runningSubagents = Math.max(0, runningSubagents + delta);
	for (const listener of subagentListeners) listener();
};

const readContextPercent = (ctx: ExtensionContext): number | undefined => {
	const percent = ctx.getContextUsage()?.percent;
	return percent !== undefined && Number.isFinite(percent) ? Math.round(percent) : undefined;
};

export default function discordPresence(pi: ExtensionAPI) {
	let isSubagent = false;
	let subagentRunning = false;
	const setSubagentRunning = (running: boolean) => {
		if (subagentRunning === running) return;
		subagentRunning = running;
		changeRunningSubagents(running ? 1 : -1);
	};
	const onSubagentsChanged = () => schedulePresenceUpdate();
	let rpc: DiscordRpcClient | undefined;
	let connected = false;
	let reconnectTimer: NodeJS.Timeout | undefined;
	let app: { name?: string; iconUrl?: string } = {};
	let repo: RepoLookup = { reason: "not checked yet" };
	// Flushes wait for the repo check, so a private repo's name is never sent before it is known to be private.
	let repoCheck: Promise<unknown> = Promise.resolve();
	let lastActivity: DiscordRPC.Presence | undefined;
	let idleSince: number | undefined;
	let wslBridge: Server | undefined;
	let updateTimer: NodeJS.Timeout | undefined;
	let lastFlushAt = 0;
	let awayTimer: NodeJS.Timeout | undefined;
	const runningTools = new Map<string, string>(); // toolCallId -> toolName
	const pendingApprovals = new Map<string, string>(); // toolCallId -> toolName awaiting the user's approval
	let planReviewOpen = false;
	let agentRunning = false;
	let modes = ""; // formatted active omp modes, see formatModes
	let stateWatcher: FSWatcher | undefined;
	let shuttingDown = false;
	let { enabled, hiddenProjects, showContext, showModel, showButton, awayMinutes, autoHidePrivate } = readGlobalState();
	let cwd = process.cwd();

	let presence: PresenceState = {
		status: "offline",
		startedAt: Date.now(),
	};

	const autoHidden = () => autoHidePrivate && "mayBePrivate" in repo && repo.mayBePrivate === true;
	const projectHidden = () => isProjectHidden(cwd, hiddenProjects) || autoHidden();

	const clearReconnectTimer = () => {
		if (reconnectTimer) clearTimeout(reconnectTimer);
		reconnectTimer = undefined;
	};

	const clearUpdateTimer = () => {
		if (updateTimer) clearTimeout(updateTimer);
		updateTimer = undefined;
	};

	const scheduleReconnect = () => {
		if (shuttingDown || reconnectTimer || !enabled) return;
		reconnectTimer = setTimeout(() => {
			reconnectTimer = undefined;
			void connect();
		}, RECONNECT_DELAY_MS);
	};

	const buildActivity = (): DiscordRPC.Presence => {
		const { provider: rawProvider = "", id: rawId = "" } = presence.model ?? {};
		// Gateway providers already prefix the id ("amanai" + "amanai/claude-haiku-4.5"); don't repeat it.
		const model = presence.model && (rawId.startsWith(`${rawProvider}/`) ? rawId : `${rawProvider}/${rawId}`);
		const effort = pi.getThinkingLevel();
		const modelInfo =
			showModel && model ? (effort && effort !== "inherit" ? `${model} · effort: ${effort}` : model) : undefined;
		const modelSuffix = modelInfo ? ` · ${modelInfo}` : "";
		const contextSuffix = showContext && presence.contextPercent !== undefined ? ` · context ${presence.contextPercent}%` : "";
		const label = STATUS_LABELS[presence.status];
		const subagents = runningSubagents ? ` · ${runningSubagents} subagent${runningSubagents === 1 ? "" : "s"}` : "";
		// "waiting for approval · bash" reads as one phrase; other details are separate segments.
		const head = presence.detail ? `${label}${presence.status === "waiting" ? " " : " · "}${presence.detail}` : label;
		const state = `${head}${subagents}${modelSuffix}${contextSuffix}`;
		const iconKey = presence.model && modelIconKey(presence.model);
		const hidden = projectHidden();
		const project = hidden ? PRIVATE_PROJECT_LABEL : normalizeProjectName(cwd);
		const largeImageKey = LARGE_IMAGE_KEY ?? app.iconUrl;

		return {
			details: truncateDiscordText(`omp v${VERSION} · ${project}${modes ? ` · ${modes}` : ""}`),
			state: truncateDiscordText(state),
			startTimestamp: new Date(presence.startedAt),
			largeImageKey,
			largeImageText: largeImageKey ? `oh-my-pi coding agent v${VERSION}` : undefined,
			// The logo names the model's maker, so it follows the model setting.
			smallImageKey: showModel ? iconKey : undefined,
			smallImageText: showModel && iconKey ? modelInfo : undefined,
			// Discord never shows your own buttons to you; other people see them on your profile.
			buttons: showButton && "url" in repo && !hidden ? [{ label: "View on GitHub", url: repo.url }] : undefined,
			instance: false,
		};
	};

	const flushPresence = async () => {
		clearUpdateTimer();
		await repoCheck;
		if (!connected || !rpc || !enabled || shuttingDown) return;

		try {
			lastFlushAt = Date.now();
			const activity = buildActivity();
			await rpc.setActivity(activity);
			lastActivity = activity;
		} catch {
			connected = false;
			scheduleReconnect();
		}
	};

	const schedulePresenceUpdate = () => {
		if (updateTimer) return;
		const delay = Math.max(PRESENCE_UPDATE_DEBOUNCE_MS, lastFlushAt + MIN_PRESENCE_UPDATE_INTERVAL_MS - Date.now());
		updateTimer = setTimeout(() => void flushPresence(), delay);
	};

	// Arms the "away" timer from idleSince, so a changed awayMinutes applies to the current idle stretch.
	const armAwayTimer = () => {
		clearTimeout(awayTimer);
		if (presence.status !== "idle" || idleSince === undefined || awayMinutes <= 0) return;
		const remaining = Math.max(0, idleSince + awayMinutes * 60_000 - Date.now());
		awayTimer = setTimeout(() => updatePresence({ status: "away" }), remaining);
		awayTimer.unref(); // never keep omp (e.g. print mode) alive just to flip to "away"
	};

	const updatePresence = (patch: Partial<PresenceState>) => {
		presence = { ...presence, ...patch };
		// Any status change restarts the idle clock; only a quiet "idle" turns into "away".
		if (patch.status) {
			if (patch.status === "idle") idleSince = Date.now();
			else if (patch.status !== "away") idleSince = undefined;
			armAwayTimer();
		}
		schedulePresenceUpdate();
	};

	async function connect() {
		if (shuttingDown || connected || !enabled) return;

		try {
			// Re-checked on every attempt: if the session that owned the bridge exits, this one takes over.
			wslBridge ??= await startWslBridge();
			rpc = new DiscordRPC.Client({ transport: "ipc" }) as DiscordRpcClient;
			rpc.on("ready", () => {
				connected = true;
				void flushPresence();
			});
			rpc.on("disconnected", () => {
				connected = false;
				scheduleReconnect();
			});
			rpc.on("error", () => {
				connected = false;
				scheduleReconnect();
			});

			await rpc.login({ clientId: CLIENT_ID });
		} catch {
			connected = false;
			// A timed-out login leaves its socket (and on WSL a relay process) open; close it before retrying.
			try {
				rpc?.destroy?.();
			} catch {
				// Ignore cleanup errors.
			}
			rpc = undefined;
			scheduleReconnect();
		}
	}

	const clearDiscordPresence = async () => {
		clearUpdateTimer();
		clearReconnectTimer();
		connected = false;

		try {
			await rpc?.clearActivity?.();
		} catch {
			// Discord may already be closed; ignore cleanup errors.
		}

		try {
			rpc?.destroy?.();
		} catch {
			// Ignore cleanup errors.
		}

		rpc = undefined;
	};

	const applyGlobalState = async (next: GlobalState) => {
		const wasHidden = projectHidden();
		hiddenProjects = next.hiddenProjects;
		const displayChanged =
			showContext !== next.showContext ||
			showModel !== next.showModel ||
			showButton !== next.showButton ||
			autoHidePrivate !== next.autoHidePrivate;
		({ showContext, showModel, showButton, autoHidePrivate } = next);
		if (awayMinutes !== next.awayMinutes) {
			awayMinutes = next.awayMinutes;
			armAwayTimer();
		}
		if (projectHidden() !== wasHidden || displayChanged) await flushPresence();

		if (enabled === next.enabled) return;
		enabled = next.enabled;

		if (!enabled) {
			await clearDiscordPresence();
			return;
		}

		updatePresence({
			status: "idle",
			detail: undefined,
			startedAt: Date.now(),
		});
		await connect();
	};

	const watchGlobalState = () => {
		if (stateWatcher) return;

		mkdirSync(dirname(GLOBAL_STATE_FILE), { recursive: true });
		// Watch the directory: atomic renames replace the file inode, which would silence a file watcher.
		stateWatcher = watch(dirname(GLOBAL_STATE_FILE), { persistent: false }, (_event, filename) => {
			if (filename === basename(GLOBAL_STATE_FILE)) void applyGlobalState(readGlobalState());
		});
	};

	/** Multi-line report for `/discord-presence status`: what Discord receives and why parts may be missing. */
	const describeStatus = async (ctx: ExtensionContext): Promise<string> => {
		const transport = !IS_WSL
			? "direct IPC"
			: wslBridge
				? "WSL bridge started by this session"
				: "WSL, shared socket from another omp session or a relay";
		if (!app.name) app = await fetchAppInfo(); // the startup fetch may have failed (offline, rate limit)
		const activity = lastActivity ?? buildActivity();
		const iconKey = activity.smallImageKey;
		const uploaded = iconKey ? await fetchUploadedAssets() : undefined;
		const logo = !showModel
			? "hidden (model hidden in settings)"
			: !iconKey
				? "none (no lobe-icons rule matches this model)"
				: `${iconKey} ${uploaded === undefined ? "(could not check Art Assets)" : uploaded.has(iconKey) ? "✓ uploaded" : "✗ not uploaded as an Art Asset"}`;
		const hidden = projectHidden();
		const button = !showButton
			? "none (turned off in settings)"
			: hidden
				? "none (project hidden)"
				: "url" in repo
					? `View on GitHub → ${repo.url}`
					: `none (${repo.reason})`;
		const away =
			presence.status === "away"
				? `away (idle ${formatDuration(Date.now() - (idleSince ?? Date.now()))})`
				: idleSince !== undefined
					? awayMinutes > 0
						? `idle ${formatDuration(Date.now() - idleSince)}, away in ${formatDuration(Math.max(0, idleSince + awayMinutes * 60_000 - Date.now()))}`
						: `idle ${formatDuration(Date.now() - idleSince)}, away never`
					: "active";
		const context = readContextPercent(ctx);
		return [
			`Discord presence: ${enabled ? "enabled" : "disabled"} · ${connected ? `connected (${transport})` : "not connected"}`,
			`App: ${app.name ?? "?"} (${CLIENT_ID})`,
			"",
			lastActivity ? "Sent to Discord:" : "Would send (not connected yet):",
			`  ${activity.details}`,
			`  ${activity.state}`,
			`  logo: ${logo}`,
			`  button: ${button}`,
			lastActivity ? `  last update ${formatDuration(Date.now() - lastFlushAt)} ago` : "",
			"",
			`Project: ${normalizeProjectName(cwd)} · ${isProjectHidden(cwd, hiddenProjects) ? "hidden" : autoHidden() ? `hidden automatically (${"reason" in repo ? repo.reason : ""})` : "visible"}`,
			`Context: ${showContext ? "shown" : "hidden"}${context === undefined ? "" : ` (now ${context}%)`} · ${away}`,
			`Settings: ${GLOBAL_STATE_FILE}`,
		]
			.filter((line, index, lines) => line !== "" || lines[index - 1] !== "")
			.join("\n");
	};

	const setProjectHidden = async (projectCwd: string, hide: boolean) => {
		const { hiddenProjects: current } = readGlobalState();
		if (hide === isProjectHidden(projectCwd, current)) return;
		// Showing removes every entry covering this cwd, including a hidden parent directory.
		const next = hide ? [...current, projectCwd] : current.filter((project) => !isProjectHidden(projectCwd, [project]));
		await applyGlobalState(writeGlobalState({ hiddenProjects: next }));
	};

	const AWAY_CHOICES = [5, 10, 15, 30, 60, 0];
	const describeAway = (minutes: number) => (minutes > 0 ? `${minutes} min` : "never");

	/** Interactive settings menu; every change is saved globally and applied live to all sessions. */
	const openSettings = async (ctx: ExtensionContext) => {
		const toggle = (on: boolean, yes = "shown", no = "hidden") => (on ? yes : no);
		let index = 0;
		for (;;) {
			const state = readGlobalState();
			const hidden = isProjectHidden(ctx.cwd, state.hiddenProjects);
			const items = [
				{ label: `Presence: ${toggle(state.enabled, "on", "off")}`, description: "Show omp activity on Discord (all sessions)" },
				{
					label: `This project: ${hidden ? "hidden" : autoHidden() ? "hidden (private repo)" : "visible"}`,
					description: `Show "${normalizeProjectName(ctx.cwd)}" or "${PRIVATE_PROJECT_LABEL}"`,
				},
				{
					label: `Auto-hide private repos: ${toggle(state.autoHidePrivate, "on", "off")}`,
					description: `"${PRIVATE_PROJECT_LABEL}" when origin is a private GitHub repo`,
				},
				{ label: `Model, effort & logo: ${toggle(state.showModel)}`, description: "e.g. anthropic/claude-opus · effort: high" },
				{ label: `GitHub button: ${toggle(state.showButton)}`, description: "View on GitHub, public repos only" },
				{ label: `Context usage: ${toggle(state.showContext)}`, description: "e.g. context 42%" },
				{ label: `Away after: ${describeAway(state.awayMinutes)}`, description: "Idle time before the status turns away" },
				{ label: "Done" },
			];
			const choice = await ctx.ui.select("Discord presence settings", items, {
				initialIndex: index,
				helpText: "Enter changes the setting · Esc closes",
			});
			index = items.findIndex((item) => item.label === choice);
			if (index === -1 || index === items.length - 1) return;

			if (index === 0) await applyGlobalState(writeGlobalState({ enabled: !state.enabled }));
			else if (index === 1) {
				if (!hidden && autoHidden()) ctx.ui.notify(SHOW_PRIVATE_HINT, "warning");
				else await setProjectHidden(ctx.cwd, !hidden);
			} else if (index === 2) await applyGlobalState(writeGlobalState({ autoHidePrivate: !state.autoHidePrivate }));
			else if (index === 3) await applyGlobalState(writeGlobalState({ showModel: !state.showModel }));
			else if (index === 4) await applyGlobalState(writeGlobalState({ showButton: !state.showButton }));
			else if (index === 5) await applyGlobalState(writeGlobalState({ showContext: !state.showContext }));
			else {
				const labels = AWAY_CHOICES.map((minutes) => describeAway(minutes) + (minutes === DEFAULT_STATE.awayMinutes ? " (default)" : ""));
				const picked = await ctx.ui.select("Away after", labels, {
					initialIndex: Math.max(0, AWAY_CHOICES.indexOf(state.awayMinutes)),
				});
				const minutes = AWAY_CHOICES[labels.indexOf(picked ?? "")];
				if (minutes !== undefined) await applyGlobalState(writeGlobalState({ awayMinutes: minutes }));
			}
		}
	};

	pi.registerCommand("discord-presence", {
		description: `toggle Discord Rich Presence for all omp sessions, or hide/show this project's name. ${USAGE}`,
		handler: async (args, ctx) => {
			cwd = ctx.cwd;
			await applyGlobalState(readGlobalState());
			const [verb = "", arg] = args.trim().toLowerCase().split(/\s+/);
			const action = verb || (enabled ? "off" : "on");

			switch (action) {
				case "off":
				case "on":
					await applyGlobalState(writeGlobalState({ enabled: action === "on" }));
					ctx.ui.notify(`discord rich presence ${action === "on" ? "enabled" : "disabled"} globally.`, "info");
					return;
				case "hide":
				case "private":
					await setProjectHidden(ctx.cwd, true);
					ctx.ui.notify(`project name hidden on discord; showing "${PRIVATE_PROJECT_LABEL}" instead.`, "info");
					return;
				case "show":
				case "public":
					await setProjectHidden(ctx.cwd, false);
					if (autoHidden()) ctx.ui.notify(SHOW_PRIVATE_HINT, "warning");
					else ctx.ui.notify(`project name "${normalizeProjectName(ctx.cwd)}" visible on discord.`, "info");
					return;
				case "settings":
					if (!ctx.hasUI) {
						ctx.ui.notify("settings needs the interactive TUI; edit the settings file shown by /discord-presence status.", "warning");
						return;
					}
					await openSettings(ctx);
					return;
				case "refresh":
					await flushPresence();
					ctx.ui.notify("discord rich presence refreshed.", "info");
					return;
				case "context":
					if (arg !== "on" && arg !== "off") {
						ctx.ui.notify("usage: /discord-presence context on|off", "warning");
						return;
					}
					await applyGlobalState(writeGlobalState({ showContext: arg === "on" }));
					ctx.ui.notify(`context usage ${arg === "on" ? "shown" : "hidden"} on discord.`, "info");
					return;
				case "status": {
					const report = await describeStatus(ctx);
					ctx.ui.notify(report, connected ? "info" : "warning");
					return;
				}
				default:
					ctx.ui.notify(USAGE, "warning");
			}
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		// Factories are rebound to every subagent session; only the main session owns the Discord connection.
		if (ctx.agent.kind !== "main") {
			isSubagent = true;
			return;
		}
		subagentListeners.add(onSubagentsChanged);
		shuttingDown = false;
		cwd = ctx.cwd;
		watchGlobalState();
		({ enabled, hiddenProjects, showContext, showModel, showButton, awayMinutes, autoHidePrivate } = readGlobalState());
		updatePresence({
			status: "idle",
			model: ctx.model,
			contextPercent: readContextPercent(ctx),
			startedAt: Date.now(),
		});
		// Discord hides the small (brand) image without a large one; default to the app's own icon.
		if (!app.name) void fetchAppInfo().then((info) => {
			app = info;
			schedulePresenceUpdate();
		});
		modes = formatModes(ctx.sessionModes?.getState()); // TUI only; mode_changed covers the rest
		// omp emits no model/effort change event; poll the live selection so a switch shows without a prompt.
		let lastEffort = pi.getThinkingLevel();
		ctx.setInterval(() => {
			const model = ctx.model;
			const effort = pi.getThinkingLevel();
			if (model?.provider === presence.model?.provider && model?.id === presence.model?.id && effort === lastEffort) return;
			lastEffort = effort;
			updatePresence({ model });
		}, MODEL_POLL_MS);
		repo = { reason: "checking GitHub" };
		repoCheck = findPublicGithubRepo(ctx.cwd).then((lookup) => {
			repo = lookup;
			schedulePresenceUpdate();
		});
		if (enabled) void connect();
	});

	// The status everything returns to: waiting on the user beats a running tool, which beats thinking/idle.
	const currentActivity = (): Pick<PresenceState, "status" | "detail"> => {
		const approval = [...pendingApprovals.values()].at(-1);
		if (approval) return { status: "waiting", detail: `approval · ${approval}` };
		const tools = [...runningTools.values()];
		// The ask tool blocks on the user's answer rather than doing work.
		if (tools.includes("ask")) return { status: "waiting", detail: "your answer" };
		if (planReviewOpen) return { status: "waiting", detail: "plan review" };
		const tool = tools.at(-1);
		if (tool) return { status: "tool", detail: tool };
		return { status: agentRunning ? "working" : "idle", detail: undefined };
	};

	pi.on("agent_start", async (_event, ctx) => {
		if (isSubagent) return setSubagentRunning(true);
		runningTools.clear();
		pendingApprovals.clear();
		agentRunning = true;
		updatePresence({
			...currentActivity(),
			model: ctx.model,
			startedAt: Date.now(),
		});
	});

	// Tools can run in parallel: stay on "using tool" until the last one finishes.
	pi.on("tool_execution_start", async (event) => {
		runningTools.set(event.toolCallId, event.toolName);
		updatePresence(currentActivity());
	});

	pi.on("tool_execution_end", async (event) => {
		runningTools.delete(event.toolCallId);
		pendingApprovals.delete(event.toolCallId);
		updatePresence(currentActivity());
	});

	// Fired only when omp's approval mode prompts for a tool call; the reason is not shown (it can quote the command).
	pi.on("tool_approval_requested", async (event) => {
		pendingApprovals.set(event.toolCallId, event.toolName);
		updatePresence(currentActivity());
	});

	pi.on("tool_approval_resolved", async (event) => {
		pendingApprovals.delete(event.toolCallId);
		updatePresence(currentActivity());
	});

	pi.on("plan_review_requested", async () => {
		planReviewOpen = true;
		updatePresence(currentActivity());
	});

	pi.on("plan_review_resolved", async () => {
		planReviewOpen = false;
		updatePresence(currentActivity());
	});

	pi.on("auto_compaction_start", async () => {
		updatePresence({ status: "compacting", detail: undefined });
	});

	pi.on("auto_compaction_end", async (_event, ctx) => {
		updatePresence({ ...currentActivity(), contextPercent: readContextPercent(ctx) });
	});

	// Context grows every turn; no status change, so the away clock is untouched.
	pi.on("turn_end", async (_event, ctx) => {
		updatePresence({ contextPercent: readContextPercent(ctx) });
	});

	// The error message is not shown: it can contain request details.
	pi.on("auto_retry_start", async (event) => {
		updatePresence({ status: "retrying", detail: `attempt ${event.attempt}/${event.maxAttempts}` });
	});

	pi.on("auto_retry_end", async () => {
		updatePresence(currentActivity());
	});

	pi.on("agent_end", async (_event, ctx) => {
		if (isSubagent) return setSubagentRunning(false);
		runningTools.clear();
		pendingApprovals.clear();
		agentRunning = false;
		// A plan review opened at the end of a planning turn keeps the status on "waiting".
		updatePresence({ ...currentActivity(), contextPercent: readContextPercent(ctx) });
	});

	pi.on("mode_changed", async (event) => {
		modes = formatModes(event.state);
		schedulePresenceUpdate();
	});

	pi.on("session_shutdown", async () => {
		if (isSubagent) {
			setSubagentRunning(false); // a subagent aborted mid-run never sends agent_end
			return;
		}
		subagentListeners.delete(onSubagentsChanged);
		shuttingDown = true;
		clearTimeout(awayTimer);
		stateWatcher?.close();
		stateWatcher = undefined;
		await clearDiscordPresence();
		if (wslBridge) {
			wslBridge.close();
			rmSync(IPC_SOCKET_PATH, { force: true });
			wslBridge = undefined;
		}
	});
}
