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
// shortcut: fixed 15 min; make it a plugin setting once settings exist.
const AWAY_AFTER_MS = 15 * 60_000;
const DISCORD_TEXT_LIMIT = 128;
const PRIVATE_PROJECT_LABEL = "private project";

type PresenceStatus = "idle" | "away" | "working" | "tool" | "compacting" | "retrying" | "offline";

const STATUS_LABELS: Record<PresenceStatus, string> = {
	idle: "idle",
	working: "thinking",
	tool: "using tool",
	compacting: "compacting context",
	retrying: "retrying",
	away: "away",
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
		const parsed = JSON.parse(readFileSync(GLOBAL_STATE_FILE, "utf8")) as {
			enabled?: unknown;
			hiddenProjects?: unknown;
			showContext?: unknown;
		};
		return {
			enabled: parsed.enabled !== false,
			hiddenProjects: Array.isArray(parsed.hiddenProjects)
				? parsed.hiddenProjects.filter((project): project is string => typeof project === "string")
				: [],
			showContext: parsed.showContext === true,
		};
	} catch {
		return { enabled: true, hiddenProjects: [], showContext: false };
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

const fetchAppIconUrl = async (): Promise<string | undefined> => {
	try {
		const response = await fetch(`https://discord.com/api/v10/applications/${CLIENT_ID}/rpc`);
		const app = (await response.json()) as { icon?: string | null };
		return app.icon ? `https://cdn.discordapp.com/app-icons/${CLIENT_ID}/${app.icon}.png?size=512` : undefined;
	} catch {
		return undefined;
	}
};

const execFileAsync = promisify(execFile);
// Captures owner/repo from https, ssh and scp-style remotes; credentials before the host are never captured.
const GITHUB_REMOTE = /github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/;

/** The public GitHub URL of cwd's `origin` remote, if any. */
const findPublicGithubRepo = async (cwd: string): Promise<string | undefined> => {
	try {
		const { stdout } = await execFileAsync("git", ["-C", cwd, "remote", "get-url", "origin"]);
		const slug = GITHUB_REMOTE.exec(stdout.trim())?.[1];
		if (!slug) return undefined;
		// Only link public repos: a private repo's URL would leak its owner/name to everyone viewing the profile.
		const response = await fetch(`https://api.github.com/repos/${slug}`, {
			headers: { "User-Agent": "omp-discord-presence" },
		});
		return response.ok ? `https://github.com/${slug}` : undefined;
	} catch {
		return undefined; // not a git repo, no origin, git missing, or offline
	}
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

const USAGE = "usage: /discord-presence [on|off|status|refresh|hide|show|context on|context off]";

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
	let appIconUrl: string | undefined;
	let repoUrl: string | undefined;
	let wslBridge: Server | undefined;
	let updateTimer: NodeJS.Timeout | undefined;
	let lastFlushAt = 0;
	let awayTimer: NodeJS.Timeout | undefined;
	const runningTools = new Map<string, string>(); // toolCallId -> toolName
	let agentRunning = false;
	let modes = ""; // formatted active omp modes, see formatModes
	let stateWatcher: FSWatcher | undefined;
	let shuttingDown = false;
	let { enabled, hiddenProjects, showContext } = readGlobalState();
	let cwd = process.cwd();

	let presence: PresenceState = {
		status: "offline",
		startedAt: Date.now(),
	};

	const projectHidden = () => isProjectHidden(cwd, hiddenProjects);

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
		const modelInfo = model && (effort && effort !== "inherit" ? `${model} · effort: ${effort}` : model);
		const modelSuffix = modelInfo ? ` · ${modelInfo}` : "";
		const contextSuffix = showContext && presence.contextPercent !== undefined ? ` · context ${presence.contextPercent}%` : "";
		const label = STATUS_LABELS[presence.status];
		const subagents = runningSubagents ? ` · ${runningSubagents} subagent${runningSubagents === 1 ? "" : "s"}` : "";
		const state = `${presence.detail ? `${label} · ${presence.detail}` : label}${subagents}${modelSuffix}${contextSuffix}`;
		const iconKey = presence.model && modelIconKey(presence.model);
		const hidden = projectHidden();
		const project = hidden ? PRIVATE_PROJECT_LABEL : normalizeProjectName(cwd);
		const largeImageKey = LARGE_IMAGE_KEY ?? appIconUrl;

		return {
			details: truncateDiscordText(`omp v${VERSION} · ${project}${modes ? ` · ${modes}` : ""}`),
			state: truncateDiscordText(state),
			startTimestamp: new Date(presence.startedAt),
			largeImageKey,
			largeImageText: largeImageKey ? `oh-my-pi coding agent v${VERSION}` : undefined,
			smallImageKey: iconKey,
			smallImageText: iconKey && modelInfo,
			// Discord never shows your own buttons to you; other people see them on your profile.
			buttons: repoUrl && !hidden ? [{ label: "View on GitHub", url: repoUrl }] : undefined,
			instance: false,
		};
	};

	const flushPresence = async () => {
		clearUpdateTimer();
		if (!connected || !rpc || !enabled || shuttingDown) return;

		try {
			lastFlushAt = Date.now();
			await rpc.setActivity(buildActivity());
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

	const updatePresence = (patch: Partial<PresenceState>) => {
		presence = { ...presence, ...patch };
		// Any status change restarts the idle clock; only a quiet "idle" turns into "away".
		if (patch.status) {
			clearTimeout(awayTimer);
			if (patch.status === "idle") {
				awayTimer = setTimeout(() => updatePresence({ status: "away" }), AWAY_AFTER_MS);
				awayTimer.unref(); // never keep omp (e.g. print mode) alive just to flip to "away"
			}
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
		const contextChanged = showContext !== next.showContext;
		showContext = next.showContext;
		if (projectHidden() !== wasHidden || contextChanged) await flushPresence();

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

	pi.registerCommand("discord-presence", {
		description: `toggle Discord Rich Presence for all omp sessions, or hide/show this project's name. ${USAGE}`,
		handler: async (args, ctx) => {
			cwd = ctx.cwd;
			const current = readGlobalState();
			await applyGlobalState(current);
			const [verb = "", arg] = args.trim().toLowerCase().split(/\s+/);
			const action = verb || (enabled ? "off" : "on");

			switch (action) {
				case "off":
				case "on":
					await applyGlobalState(writeGlobalState({ enabled: action === "on" }));
					ctx.ui.notify(`discord rich presence ${action === "on" ? "enabled" : "disabled"} globally.`, "info");
					return;
				case "hide":
				case "private": {
					if (!projectHidden()) {
						await applyGlobalState(writeGlobalState({ hiddenProjects: [...current.hiddenProjects, ctx.cwd] }));
					}
					ctx.ui.notify(`project name hidden on discord; showing "${PRIVATE_PROJECT_LABEL}" instead.`, "info");
					return;
				}
				case "show":
				case "public": {
					// Unhide every entry covering this cwd, including a hidden parent directory.
					const remaining = current.hiddenProjects.filter((project) => !isProjectHidden(ctx.cwd, [project]));
					await applyGlobalState(writeGlobalState({ hiddenProjects: remaining }));
					ctx.ui.notify(`project name "${normalizeProjectName(ctx.cwd)}" visible on discord.`, "info");
					return;
				}
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
				case "status":
					ctx.ui.notify(
						`discord presence: ${enabled ? "enabled globally" : "disabled globally"}, ${connected ? "connected" : "not connected"}, project ${projectHidden() ? "hidden" : "visible"}, context ${showContext ? `shown (${readContextPercent(ctx) ?? "?"}%)` : "hidden"}`,
						connected ? "info" : "warning",
					);
					return;
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
		({ enabled, hiddenProjects, showContext } = readGlobalState());
		updatePresence({
			status: "idle",
			model: ctx.model,
			contextPercent: readContextPercent(ctx),
			startedAt: Date.now(),
		});
		// Discord hides the small (brand) image without a large one; default to the app's own icon.
		if (!LARGE_IMAGE_KEY && !appIconUrl) void fetchAppIconUrl().then((url) => {
			appIconUrl = url;
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
		repoUrl = undefined;
		void findPublicGithubRepo(ctx.cwd).then((url) => {
			repoUrl = url;
			if (url) schedulePresenceUpdate();
		});
		if (enabled) void connect();
	});

	// What the status returns to once a tool, compaction or retry finishes.
	const currentActivity = (): Pick<PresenceState, "status" | "detail"> => {
		const tool = [...runningTools.values()].at(-1);
		if (tool) return { status: "tool", detail: tool };
		return { status: agentRunning ? "working" : "idle", detail: undefined };
	};

	pi.on("agent_start", async (_event, ctx) => {
		if (isSubagent) return setSubagentRunning(true);
		runningTools.clear();
		agentRunning = true;
		updatePresence({
			status: "working",
			detail: undefined,
			model: ctx.model,
			startedAt: Date.now(),
		});
	});

	// Tools can run in parallel: stay on "using tool" until the last one finishes.
	pi.on("tool_execution_start", async (event) => {
		runningTools.set(event.toolCallId, event.toolName);
		updatePresence({ status: "tool", detail: event.toolName });
	});

	pi.on("tool_execution_end", async (event) => {
		runningTools.delete(event.toolCallId);
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
		agentRunning = false;
		updatePresence({
			status: "idle",
			detail: undefined,
			contextPercent: readContextPercent(ctx),
		});
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
