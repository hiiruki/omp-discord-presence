import type { ExtensionAPI, ExtensionContext, SessionModeState } from "@oh-my-pi/pi-coding-agent";
// Resolved by omp's loader to the running host, so these are the installed omp's version and active profile dir.
import { getAgentDir, VERSION } from "@oh-my-pi/pi-utils";
import { execFile, spawn } from "node:child_process";
import {
	chmodSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	watch,
	writeFileSync,
	type FSWatcher,
} from "node:fs";
import { createConnection, createServer, type Server } from "node:net";
import { release } from "node:os";
import { basename, dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { connectDiscordIpc, discordIpcPath, type Activity, type DiscordIpcClient } from "./discord-ipc.ts";
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
// omp's agent dir: ~/.omp/agent by default, the profile's dir under `omp --profile`, or PI_CODING_AGENT_DIR.
const GLOBAL_STATE_FILE = join(getAgentDir(), "discord-presence-state.json");
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
	/** Minutes idle before the activity is removed from Discord until the next prompt; 0 never. */
	clearMinutes: number;
	/** What the elapsed timer counts from: the latest prompt, or the session start. */
	timer: "prompt" | "session";
	/** Show "private project" when origin is a private (or unverifiable) GitHub repo. */
	autoHidePrivate: boolean;
	/** Opt-in: append the current git branch to the project name. */
	showBranch: boolean;
	/** Per-project overrides of the display settings, keyed by absolute path (subdirectories included). */
	projects: Record<string, ProjectOverrides>;
};

/** Display settings a project can override; anything else is global only. */
const PROJECT_SETTINGS = ["showModel", "showButton", "showBranch", "showContext"] as const;
type ProjectSetting = (typeof PROJECT_SETTINGS)[number];
type ProjectOverrides = Partial<Record<ProjectSetting, boolean>>;

const DEFAULT_STATE: GlobalState = {
	enabled: true,
	hiddenProjects: [],
	showContext: false,
	showModel: true,
	showButton: true,
	awayMinutes: 15,
	clearMinutes: 0,
	timer: "prompt",
	autoHidePrivate: true,
	showBranch: false,
	projects: {},
};

const truncateDiscordText = (value: string): string => {
	if (value.length <= DISCORD_TEXT_LIMIT) return value;
	return `${value.slice(0, DISCORD_TEXT_LIMIT - 1)}…`;
};

const normalizeProjectName = (cwd: string): string => {
	const parts = cwd.split(/[\\/]/).filter(Boolean);
	return parts.at(-1) ?? "omp session";
};

const coversPath = (cwd: string, project: string) =>
	cwd === project || cwd.startsWith(project.endsWith(sep) ? project : project + sep);

const isProjectHidden = (cwd: string, hiddenProjects: string[]): boolean =>
	hiddenProjects.some((project) => coversPath(cwd, project));

/** The overrides entry for cwd: the deepest project path that covers it. */
const projectKeyFor = (cwd: string, projects: GlobalState["projects"]): string | undefined =>
	Object.keys(projects)
		.filter((project) => coversPath(cwd, project))
		.sort((a, b) => b.length - a.length)[0];

/** Display settings in force for cwd: the global value unless the project overrides it. */
const effectiveSettings = (state: GlobalState, cwd: string): Record<ProjectSetting, boolean> => {
	const key = projectKeyFor(cwd, state.projects);
	const overrides = key ? state.projects[key] : undefined;
	return Object.fromEntries(
		PROJECT_SETTINGS.map((setting) => [setting, overrides?.[setting] ?? state[setting]]),
	) as Record<ProjectSetting, boolean>;
};

const parseProjects = (value: unknown): GlobalState["projects"] => {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	const projects: GlobalState["projects"] = {};
	for (const [path, raw] of Object.entries(value)) {
		if (!raw || typeof raw !== "object") continue;
		const overrides: ProjectOverrides = {};
		for (const setting of PROJECT_SETTINGS) {
			const flag = (raw as Record<string, unknown>)[setting];
			if (typeof flag === "boolean") overrides[setting] = flag;
		}
		if (Object.keys(overrides).length > 0) projects[path] = overrides;
	}
	return projects;
};

const readGlobalState = (): GlobalState => {
	try {
		const parsed = JSON.parse(readFileSync(GLOBAL_STATE_FILE, "utf8")) as Partial<Record<keyof GlobalState, unknown>>;
		const { awayMinutes, clearMinutes } = parsed;
		const minutes = (value: unknown, fallback: number) =>
			typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
		return {
			enabled: parsed.enabled !== false,
			hiddenProjects: Array.isArray(parsed.hiddenProjects)
				? parsed.hiddenProjects.filter((project): project is string => typeof project === "string")
				: [],
			showContext: parsed.showContext === true,
			showModel: parsed.showModel !== false,
			showButton: parsed.showButton !== false,
			autoHidePrivate: parsed.autoHidePrivate !== false,
			showBranch: parsed.showBranch === true,
			projects: parseProjects(parsed.projects),
			timer: parsed.timer === "session" ? "session" : "prompt",
			awayMinutes: minutes(awayMinutes, DEFAULT_STATE.awayMinutes),
			clearMinutes: minutes(clearMinutes, DEFAULT_STATE.clearMinutes),
		};
	} catch {
		return { ...DEFAULT_STATE };
	}
};

// One marker file per running main session, named "<pid>-<n>", so every omp process can count the open sessions.
const SESSIONS_DIR = join(getAgentDir(), "discord-presence-sessions");
let sessionMarkerSeq = 0;

const isProcessAlive = (pid: number): boolean => {
	try {
		process.kill(pid, 0); // signal 0 only checks that the process exists
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM"; // exists, owned by someone else
	}
};

/** Open omp sessions across all processes; markers left by crashed processes are removed. */
const countOpenSessions = (): number => {
	let names: string[];
	try {
		names = readdirSync(SESSIONS_DIR);
	} catch {
		return 0;
	}
	let count = 0;
	for (const name of names) {
		const pid = Number(name.split("-")[0]);
		if (Number.isInteger(pid) && pid > 0 && isProcessAlive(pid)) count++;
		else rmSync(join(SESSIONS_DIR, name), { force: true });
	}
	return count;
};

/** "plan mode + goal mode (paused)"; the goal objective and plan path stay private. */
const formatModes = (state: SessionModeState | undefined): string =>
	state
		? (["plan", "goal", "loop", "vibe"] as const)
				.filter((mode) => state[mode].status !== "inactive")
				.map((mode) => `${mode} mode${state[mode].status === "paused" ? " (paused)" : ""}`)
				.join(" + ")
		: "";

/** Write-then-rename, so a concurrent reader never sees a half-written file. */
const writeJsonAtomic = (file: string, data: unknown) => {
	mkdirSync(dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
	renameSync(tmp, file);
};

const writeGlobalState = (patch: Partial<GlobalState>): GlobalState => {
	const next = { ...readGlobalState(), ...patch };
	// Atomic so other sessions never read a half-written file (and briefly leak hidden names).
	writeJsonAtomic(GLOBAL_STATE_FILE, next);
	return next;
};

type AppInfo = { name?: string; iconUrl?: string };

/** Public application info (no auth): the name Discord shows as the activity title, and its icon. */
const fetchAppInfo = async (): Promise<AppInfo> => {
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

// The last fetched app info, so the first update of a session already carries the large image (Discord drops the
// model logo without one) and a Discord API outage doesn't strip it. Refreshed in the background every session.
const APP_CACHE_FILE = join(getAgentDir(), "discord-presence-app.json");

const readCachedAppInfo = (): AppInfo => {
	try {
		const cached = JSON.parse(readFileSync(APP_CACHE_FILE, "utf8")) as Record<string, unknown>;
		if (cached.clientId !== CLIENT_ID) return {};
		return {
			name: typeof cached.name === "string" ? cached.name : undefined,
			iconUrl: typeof cached.iconUrl === "string" ? cached.iconUrl : undefined,
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

/** The repository's git directory (worktree-aware); one git call per session instead of one per branch check. */
const resolveGitDir = (cwd: string): Promise<string | undefined> =>
	execFileAsync("git", ["-C", cwd, "rev-parse", "--absolute-git-dir"], { timeout: LOOKUP_TIMEOUT_MS })
		.then(({ stdout }) => stdout.trim() || undefined)
		.catch(() => undefined);

/** The checked-out branch read from HEAD, or the short commit on a detached HEAD; no git process. */
const readHeadBranch = (gitDir: string): string | undefined => {
	try {
		const head = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
		const ref = /^ref: refs\/heads\/(.+)$/.exec(head);
		if (ref) return ref[1];
		return /^[0-9a-f]{40,64}$/.test(head) ? head.slice(0, 7) : undefined;
	} catch {
		return undefined;
	}
};

// Last definitive visibility per repo (true = public). A known-public repo stays public through a GitHub outage or
// rate limit (otherwise auto-hide would fail closed), and sessions don't wait on the network. Revalidated on every
// lookup; only a definitive answer (200 or 404) replaces it.
const VISIBILITY_CACHE_FILE = join(getAgentDir(), "discord-presence-github.json");

const readVisibilityCache = (): Record<string, boolean> => {
	try {
		const parsed: unknown = JSON.parse(readFileSync(VISIBILITY_CACHE_FILE, "utf8"));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
		return Object.fromEntries(Object.entries(parsed).filter(([, isPublic]) => typeof isPublic === "boolean"));
	} catch {
		return {};
	}
};

const writeVisibility = (slug: string, isPublic: boolean) => {
	try {
		const cache = readVisibilityCache();
		if (cache[slug] === isPublic) return;
		cache[slug] = isPublic;
		writeJsonAtomic(VISIBILITY_CACHE_FILE, cache);
	} catch {
		// A cache we can't write only costs the next session a network round trip.
	}
};

const githubLookup = (slug: string, isPublic: boolean): RepoLookup =>
	isPublic ? { url: `https://github.com/${slug}`, slug } : { reason: "private GitHub repo", mayBePrivate: true };

/** Asks GitHub anonymously; a non-definitive answer comes back as a reason. Never rejects. */
const fetchVisibility = async (slug: string): Promise<{ isPublic: boolean } | { reason: string }> => {
	try {
		// Only link public repos: a private repo's URL would leak its owner/name to everyone viewing the profile.
		const response = await fetch(`https://api.github.com/repos/${slug}`, {
			headers: { "User-Agent": "omp-discord-presence" },
			signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
		});
		if (response.ok) return { isPublic: true };
		if (response.status === 404) return { isPublic: false };
		return { reason: `GitHub API HTTP ${response.status}, visibility unknown` };
	} catch {
		return { reason: "GitHub API unreachable, visibility unknown" };
	}
};

/**
 * The public GitHub URL of cwd's `origin` remote, or why there is none. With a cached answer, `lookup` is that answer
 * (no network wait) and `revalidated` resolves to a changed definitive answer, or undefined when nothing changed.
 */
const findPublicGithubRepo = async (
	cwd: string,
): Promise<{ lookup: RepoLookup; revalidated?: Promise<RepoLookup | undefined> }> => {
	let slug: string | undefined;
	try {
		const { stdout } = await execFileAsync("git", ["-C", cwd, "remote", "get-url", "origin"], {
			timeout: LOOKUP_TIMEOUT_MS,
		});
		slug = GITHUB_REMOTE.exec(stdout.trim())?.[1];
	} catch {
		return { lookup: { reason: "no git origin remote" } };
	}
	// shortcut: ssh host aliases (git@github-work:owner/repo) aren't recognized; resolve them via `ssh -G` if users need it.
	if (!slug) return { lookup: { reason: "origin is not on GitHub" } };
	const repoSlug = slug;
	const cached = readVisibilityCache()[repoSlug];
	const live = fetchVisibility(repoSlug).then((result) => {
		if ("isPublic" in result) writeVisibility(repoSlug, result.isPublic);
		return result;
	});
	if (cached === undefined) {
		const result = await live;
		return { lookup: "isPublic" in result ? githubLookup(repoSlug, result.isPublic) : { reason: result.reason, mayBePrivate: true } };
	}
	return {
		lookup: githubLookup(repoSlug, cached),
		revalidated: live.then((result) =>
			"isPublic" in result && result.isPublic !== cached ? githubLookup(repoSlug, result.isPublic) : undefined,
		),
	};
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

// WSL: Discord runs on Windows and only exposes a named pipe, so serve the Unix socket the IPC client looks for
// and relay each connection through the bundled npiperelay.exe.
const IS_WSL = process.platform === "linux" && (!!process.env.WSL_DISTRO_NAME || /microsoft/i.test(release()));
const IPC_SOCKET_PATH = discordIpcPath(0);
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

// Subcommands offered by Tab completion; the aliases (private, public) still work but aren't listed.
const SUBCOMMANDS: [value: string, description: string][] = [
	["settings", "Open the settings menu"],
	["status", "What Discord receives, and why parts may be missing"],
	["hide", "Show \"private project\" instead of this project's name"],
	["show", "Show this project's name again"],
	["on", "Turn the presence on in every session"],
	["off", "Turn the presence off in every session"],
	["refresh", "Send the current status to Discord now"],
	["context on", "Show context-window usage"],
	["context off", "Hide context-window usage"],
];
const USAGE = `usage: /discord-presence [${SUBCOMMANDS.map(([value]) => value).join("|")}]`;
const SHOW_PRIVATE_HINT =
	"this project is hidden because its GitHub repo is private (or its visibility can't be checked); turn off \"Auto-hide private repos\" in /discord-presence settings to show it.";

// Subagent sessions run in this process with rebound copies of this factory, so they share this module.
// Each one reports while its agent loop runs (nested subagents included); the main session displays the total.
let runningSubagents = 0;
// Subagents started since the count was last zero: the party's max, so "(2 of 4)" reads as 2 still working of 4.
let batchSubagents = 0;
const subagentListeners = new Set<() => void>();
const changeRunningSubagents = (delta: 1 | -1) => {
	runningSubagents = Math.max(0, runningSubagents + delta);
	if (delta === 1) batchSubagents++;
	if (runningSubagents === 0) batchSubagents = 0;
	for (const listener of subagentListeners) listener();
};

const readContextPercent = (ctx: ExtensionContext): number | undefined => {
	const percent = ctx.getContextUsage()?.percent;
	return percent !== undefined && Number.isFinite(percent) ? Math.round(percent) : undefined;
};

// Test seams: pure helpers covered by test/*.test.ts. omp only uses the default export.
export { DEFAULT_STATE, effectiveSettings, formatDuration, GITHUB_REMOTE, modelIconKey };
export type { GlobalState };

export default function discordPresence(pi: ExtensionAPI) {
	let isSubagent = false;
	let subagentRunning = false;
	const setSubagentRunning = (running: boolean) => {
		if (subagentRunning === running) return;
		subagentRunning = running;
		changeRunningSubagents(running ? 1 : -1);
	};
	const onSubagentsChanged = () => schedulePresenceUpdate();
	let rpc: DiscordIpcClient | undefined;
	let connected = false;
	let reconnectTimer: NodeJS.Timeout | undefined;
	let app: AppInfo = {};
	let repo: RepoLookup = { reason: "not checked yet" };
	// Flushes wait for the repo check, so a private repo's name is never sent before it is known to be private.
	let repoCheck: Promise<unknown> = Promise.resolve();
	let repoLookupId = 0;
	let lastActivity: Activity | undefined;
	let idleSince: number | undefined;
	let wslBridge: Server | undefined;
	let updateTimer: NodeJS.Timeout | undefined;
	let lastFlushAt = 0;
	let awayTimer: NodeJS.Timeout | undefined;
	let clearTimer: NodeJS.Timeout | undefined;
	let idleCleared = false; // idle past clearMinutes: Discord shows nothing until the next status change
	const runningTools = new Map<string, string>(); // toolCallId -> toolName
	const pendingApprovals = new Map<string, string>(); // toolCallId -> toolName awaiting the user's approval
	let planReviewOpen = false;
	let agentRunning = false;
	let modes = ""; // formatted active omp modes, see formatModes
	let stateWatcher: FSWatcher | undefined;
	let sessionsWatcher: FSWatcher | undefined;
	let sessionMarker: string | undefined;
	let openSessions = 1;
	let sessionStartedAt = Date.now();
	let shuttingDown = false;
	const initial = readGlobalState();
	let { enabled, hiddenProjects, awayMinutes, clearMinutes, autoHidePrivate, timer } = initial;
	// Display settings in force for cwd: global values with this project's overrides applied.
	let { showContext, showModel, showButton, showBranch } = effectiveSettings(initial, process.cwd());
	let projectOverrides: ProjectOverrides = {};
	let branch: string | undefined;
	let gitDir: string | undefined; // resolved once per session, only while the branch is shown
	let headWatcher: FSWatcher | undefined;
	let cwd = process.cwd();

	let presence: PresenceState = {
		status: "offline",
		startedAt: Date.now(),
	};

	const autoHidden = () => autoHidePrivate && "mayBePrivate" in repo && repo.mayBePrivate === true;
	const projectHidden = () => isProjectHidden(cwd, hiddenProjects) || autoHidden();

	const refreshBranch = () => {
		const next = gitDir ? readHeadBranch(gitDir) : undefined;
		if (next === branch) return;
		branch = next;
		if (showBranch) schedulePresenceUpdate();
	};

	/**
	 * Follows HEAD while the branch is shown: git switches branch by renaming HEAD.lock over HEAD, so watch the git
	 * directory and re-read HEAD (a small file) on its events; no git process per check.
	 */
	const startBranchWatch = async () => {
		if (headWatcher || !showBranch) return;
		gitDir ??= await resolveGitDir(cwd);
		refreshBranch();
		if (!gitDir || headWatcher || !showBranch || shuttingDown) return;
		try {
			headWatcher = watch(gitDir, { persistent: false }, (_event, filename) => {
				if (!filename || filename === "HEAD") refreshBranch();
			});
			headWatcher.on("error", () => {}); // e.g. the repo was deleted; turn_end still re-reads HEAD
		} catch {
			// Unwatchable (some network filesystems): turn_end still re-reads HEAD.
		}
	};

	const stopBranchWatch = () => {
		headWatcher?.close();
		headWatcher = undefined;
	};

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

	const buildActivity = (): Activity => {
		const { provider: rawProvider = "", id: rawId = "" } = presence.model ?? {};
		// Gateway providers already prefix the id ("amanai" + "amanai/claude-haiku-4.5"); don't repeat it.
		const model = presence.model && (rawId.startsWith(`${rawProvider}/`) ? rawId : `${rawProvider}/${rawId}`);
		const effort = pi.getThinkingLevel();
		const modelInfo =
			showModel && model ? (effort && effort !== "inherit" ? `${model} · effort: ${effort}` : model) : undefined;
		const modelSuffix = modelInfo ? ` · ${modelInfo}` : "";
		const contextSuffix = showContext && presence.contextPercent !== undefined ? ` · context ${presence.contextPercent}%` : "";
		const label = STATUS_LABELS[presence.status];
		// "waiting for approval · bash" reads as one phrase; other details are separate segments.
		const head = presence.detail ? `${label}${presence.status === "waiting" ? " " : " · "}${presence.detail}` : label;
		const state = `${head}${modelSuffix}${contextSuffix}`;
		const iconKey = presence.model && modelIconKey(presence.model);
		const hidden = projectHidden();
		const project = hidden ? PRIVATE_PROJECT_LABEL : normalizeProjectName(cwd);
		// A branch name can reveal what a hidden project is, so it goes with the project name.
		const branchSuffix = showBranch && branch && !hidden ? ` @ ${branch}` : "";
		const largeImage = LARGE_IMAGE_KEY ?? app.iconUrl;
		// The logo names the model's maker, so it follows the model setting.
		const smallImage = showModel ? iconKey : undefined;

		return {
			details: truncateDiscordText(`omp v${VERSION} · ${project}${branchSuffix}${modes ? ` · ${modes}` : ""}`),
			state: truncateDiscordText(state),
			// Per prompt: presence.startedAt resets on every agent_start. Per session: fixed at session_start.
			timestamps: { start: timer === "session" ? sessionStartedAt : presence.startedAt },
			...((largeImage || smallImage) && {
				assets: {
					large_image: largeImage,
					large_text: largeImage
						? `oh-my-pi v${VERSION} · ${openSessions} session${openSessions === 1 ? "" : "s"} open`
						: undefined,
					small_image: smallImage,
					small_text: smallImage ? modelInfo : undefined,
				},
			}),
			// Discord never shows your own buttons to you; other people see them on your profile.
			buttons: showButton && "url" in repo && !hidden ? [{ label: "View on GitHub", url: repo.url }] : undefined,
			// Discord appends "(size of max)" to the state line. The party counts agents: the main one plus subagents.
			...(runningSubagents > 0 && { party: { size: [runningSubagents + 1, batchSubagents + 1] } }),
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
			await rpc.setActivity(idleCleared ? undefined : activity);
			lastActivity = activity;
		} catch {
			// Discord stopped answering: drop this connection rather than leave its socket open next to the new one.
			rpc?.close();
			rpc = undefined;
			connected = false;
			scheduleReconnect();
		}
	};

	const schedulePresenceUpdate = () => {
		if (updateTimer) return;
		const delay = Math.max(PRESENCE_UPDATE_DEBOUNCE_MS, lastFlushAt + MIN_PRESENCE_UPDATE_INTERVAL_MS - Date.now());
		updateTimer = setTimeout(() => void flushPresence(), delay);
	};

	// Arms the "away" and clear timers from idleSince, so a changed setting applies to the current idle stretch.
	const armIdleTimers = () => {
		clearTimeout(awayTimer);
		clearTimeout(clearTimer);
		if (idleSince === undefined) return;
		if (presence.status === "idle" && awayMinutes > 0) {
			const remaining = Math.max(0, idleSince + awayMinutes * 60_000 - Date.now());
			awayTimer = setTimeout(() => updatePresence({ status: "away" }), remaining);
			awayTimer.unref(); // never keep omp (e.g. print mode) alive just to flip to "away"
		}
		if (clearMinutes > 0 && !idleCleared) {
			const remaining = Math.max(0, idleSince + clearMinutes * 60_000 - Date.now());
			clearTimer = setTimeout(() => {
				idleCleared = true;
				schedulePresenceUpdate();
			}, remaining);
			clearTimer.unref();
		}
	};

	const updatePresence = (patch: Partial<PresenceState>) => {
		presence = { ...presence, ...patch };
		// Any status change restarts the idle clock; only a quiet "idle" turns into "away", and then gets cleared.
		if (patch.status) {
			if (patch.status === "idle") idleSince = Date.now();
			else if (patch.status !== "away") idleSince = undefined;
			if (patch.status !== "away") idleCleared = false;
			armIdleTimers();
		}
		schedulePresenceUpdate();
	};

	async function connect() {
		if (shuttingDown || connected || !enabled) return;

		try {
			// Re-checked on every attempt: if the session that owned the bridge exits, this one takes over.
			wslBridge ??= await startWslBridge();
			const client = await connectDiscordIpc(CLIENT_ID, () => {
				if (rpc !== client) return; // a connection already replaced
				connected = false;
				rpc = undefined;
				scheduleReconnect();
			});
			// Turned off or shut down while the handshake was in flight.
			if (shuttingDown || !enabled) return client.close();
			rpc = client;
			connected = true;
			void flushPresence();
		} catch {
			connected = false;
			scheduleReconnect();
		}
	}

	const clearDiscordPresence = async () => {
		clearUpdateTimer();
		clearReconnectTimer();
		connected = false;

		try {
			await rpc?.setActivity(undefined);
		} catch {
			// Discord may already be closed; ignore cleanup errors.
		}

		rpc?.close();
		rpc = undefined;
	};

	const applyGlobalState = async (next: GlobalState) => {
		const wasHidden = projectHidden();
		hiddenProjects = next.hiddenProjects;
		const effective = effectiveSettings(next, cwd);
		const key = projectKeyFor(cwd, next.projects);
		projectOverrides = key ? next.projects[key]! : {};
		const displayChanged =
			showContext !== effective.showContext ||
			showModel !== effective.showModel ||
			showButton !== effective.showButton ||
			autoHidePrivate !== next.autoHidePrivate ||
			showBranch !== effective.showBranch ||
			timer !== next.timer;
		const branchTurnedOn = effective.showBranch && !showBranch;
		({ showContext, showModel, showButton, showBranch } = effective);
		if (branchTurnedOn) await startBranchWatch(); // read the branch before the flush below
		else if (!showBranch) stopBranchWatch();
		autoHidePrivate = next.autoHidePrivate;
		timer = next.timer;
		if (awayMinutes !== next.awayMinutes || clearMinutes !== next.clearMinutes) {
			({ awayMinutes, clearMinutes } = next);
			// A longer (or no) clear time brings a cleared activity back; armIdleTimers re-clears it if still due.
			if (idleCleared) schedulePresenceUpdate();
			idleCleared = false;
			armIdleTimers();
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

	/** Adds this session's marker and follows the others, so the hover text shows how many sessions are open. */
	const registerSession = () => {
		mkdirSync(SESSIONS_DIR, { recursive: true });
		sessionMarker = join(SESSIONS_DIR, `${process.pid}-${++sessionMarkerSeq}`);
		writeFileSync(sessionMarker, "");
		openSessions = countOpenSessions();
		sessionsWatcher = watch(SESSIONS_DIR, { persistent: false }, () => {
			const count = countOpenSessions();
			if (count === openSessions) return;
			openSessions = count;
			schedulePresenceUpdate();
		});
		sessionsWatcher.on("error", () => {}); // the directory can vanish; the count just stops updating
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
		const iconKey = activity.assets?.small_image;
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
		const idleFor = formatDuration(Date.now() - (idleSince ?? Date.now()));
		const away =
			idleSince === undefined
				? "active"
				: [
						presence.status === "away" ? `away (idle ${idleFor})` : `idle ${idleFor}`,
						presence.status === "away"
							? undefined
							: `away ${awayMinutes > 0 ? `in ${formatDuration(Math.max(0, idleSince + awayMinutes * 60_000 - Date.now()))}` : "never"}`,
						idleCleared
							? "cleared from Discord until the next prompt"
							: `cleared ${clearMinutes > 0 ? `in ${formatDuration(Math.max(0, idleSince + clearMinutes * 60_000 - Date.now()))}` : "never"}`,
					]
						.filter(Boolean)
						.join(", ");
		const context = readContextPercent(ctx);
		return [
			`Discord presence: ${enabled ? "enabled" : "disabled"} · ${connected ? `connected (${transport})` : "not connected"}`,
			`App: ${app.name ?? "?"} (${CLIENT_ID})`,
			"",
			lastActivity ? "Sent to Discord:" : "Would send (not connected yet):",
			`  ${activity.details}`,
			`  ${activity.state}${activity.party ? ` (${activity.party.size[0]} of ${activity.party.size[1]} agents)` : ""}`,
			`  logo: ${logo}`,
			`  button: ${button}`,
			lastActivity ? `  last update ${formatDuration(Date.now() - lastFlushAt)} ago` : "",
			"",
			`Project: ${normalizeProjectName(cwd)} · ${isProjectHidden(cwd, hiddenProjects) ? "hidden" : autoHidden() ? `hidden automatically (${"reason" in repo ? repo.reason : ""})` : "visible"} · branch ${showBranch ? (branch ?? "none (not a git repo)") : "hidden"}`,
			`Context: ${showContext ? "shown" : "hidden"}${context === undefined ? "" : ` (now ${context}%)`} · ${away}`,
			`Timer: since ${timer === "session" ? "the session started" : "the latest prompt"} · ${openSessions} omp session${openSessions === 1 ? "" : "s"} open`,
			`Project overrides: ${
				Object.entries(projectOverrides)
					.map(([setting, on]) => `${SETTING_LABELS[setting as ProjectSetting][0]} ${on ? "shown" : "hidden"}`)
					.join(", ") || "none"
			}`,
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
	const CLEAR_CHOICES = [60, 120, 240, 480, 0];
	const describeClear = (minutes: number) => (minutes > 0 ? `${minutes / 60} h idle` : "never");

	const SETTING_LABELS: Record<ProjectSetting, [label: string, description: string]> = {
		showModel: ["Model, effort & logo", "e.g. anthropic/claude-opus · effort: high"],
		showButton: ["GitHub button", "View on GitHub, public repos only"],
		showBranch: ["Git branch", "e.g. my-project @ main"],
		showContext: ["Context usage", "e.g. context 42%"],
	};

	/** Sets or clears (`undefined`) one override of the project at `key`; empty entries are dropped. */
	const writeProjectOverride = async (key: string, setting: ProjectSetting, value: boolean | undefined) => {
		const { projects } = readGlobalState();
		const overrides: ProjectOverrides = { ...projects[key], [setting]: value };
		if (value === undefined) delete overrides[setting];
		const next = { ...projects, [key]: overrides };
		if (Object.keys(overrides).length === 0) delete next[key];
		await applyGlobalState(writeGlobalState({ projects: next }));
	};

	type MenuItem = { label: string; description?: string; run?: () => Promise<void> | void };

	/**
	 * Interactive settings menu; every change is saved and applied live to all sessions. The first row switches
	 * between editing the global defaults and overriding them for this project (and its subdirectories).
	 */
	const openSettings = async (ctx: ExtensionContext) => {
		const toggle = (on: boolean, yes = "shown", no = "hidden") => (on ? yes : no);
		let projectScope = false;
		let index = 0;
		for (;;) {
			const state = readGlobalState();
			const name = normalizeProjectName(ctx.cwd);
			const hidden = isProjectHidden(ctx.cwd, state.hiddenProjects);
			// Overrides are written under the entry that already covers cwd, else under cwd itself.
			const key = projectKeyFor(ctx.cwd, state.projects) ?? ctx.cwd;
			const overrides = state.projects[key] ?? {};
			const items: MenuItem[] = [
				{
					label: `Editing: ${projectScope ? `this project (${name})` : "all projects"}`,
					description: "Enter switches between global defaults and this project's overrides",
					run: () => {
						projectScope = !projectScope;
					},
				},
				{
					label: `This project: ${hidden ? "hidden" : autoHidden() ? "hidden (private repo)" : "visible"}`,
					description: `Show "${name}" or "${PRIVATE_PROJECT_LABEL}"`,
					run: async () => {
						if (!hidden && autoHidden()) ctx.ui.notify(SHOW_PRIVATE_HINT, "warning");
						else await setProjectHidden(ctx.cwd, !hidden);
					},
				},
			];
			if (projectScope) {
				for (const setting of PROJECT_SETTINGS) {
					const [label, description] = SETTING_LABELS[setting];
					const own = overrides[setting];
					items.push({
						label: `${label}: ${toggle(own ?? state[setting])} · ${own === undefined ? "global" : "this project"}`,
						description,
						// Two states: follow the global value, or override it with the opposite.
						run: () => writeProjectOverride(key, setting, own === undefined ? !state[setting] : undefined),
					});
				}
				if (Object.keys(overrides).length > 0) {
					items.push({
						label: "Reset this project to the global settings",
						run: async () => {
							const { projects } = readGlobalState();
							delete projects[key];
							await applyGlobalState(writeGlobalState({ projects }));
						},
					});
				}
			} else {
				items.push(
					{
						label: `Presence: ${toggle(state.enabled, "on", "off")}`,
						description: "Show omp activity on Discord (all sessions)",
						run: async () => void (await applyGlobalState(writeGlobalState({ enabled: !state.enabled }))),
					},
					{
						label: `Auto-hide private repos: ${toggle(state.autoHidePrivate, "on", "off")}`,
						description: `"${PRIVATE_PROJECT_LABEL}" when origin is a private GitHub repo`,
						run: async () => void (await applyGlobalState(writeGlobalState({ autoHidePrivate: !state.autoHidePrivate }))),
					},
					...PROJECT_SETTINGS.map((setting) => ({
						label: `${SETTING_LABELS[setting][0]}: ${toggle(state[setting])}`,
						description: SETTING_LABELS[setting][1],
						run: async () => void (await applyGlobalState(writeGlobalState({ [setting]: !state[setting] }))),
					})),
					{
						label: `Timer: since ${state.timer === "session" ? "session start" : "latest prompt"}`,
						description: "What the elapsed time on Discord counts from",
						run: async () =>
							void (await applyGlobalState(writeGlobalState({ timer: state.timer === "session" ? "prompt" : "session" }))),
					},
					{
						label: `Away after: ${describeAway(state.awayMinutes)}`,
						description: "Idle time before the status turns away",
						run: async () => {
							const labels = AWAY_CHOICES.map(
								(minutes) => describeAway(minutes) + (minutes === DEFAULT_STATE.awayMinutes ? " (default)" : ""),
							);
							const picked = await ctx.ui.select("Away after", labels, {
								initialIndex: Math.max(0, AWAY_CHOICES.indexOf(state.awayMinutes)),
							});
							const minutes = AWAY_CHOICES[labels.indexOf(picked ?? "")];
							if (minutes !== undefined) await applyGlobalState(writeGlobalState({ awayMinutes: minutes }));
						},
					},
					{
						label: `Clear after: ${describeClear(state.clearMinutes)}`,
						description: "Idle time before omp disappears from Discord, until the next prompt",
						run: async () => {
							const labels = CLEAR_CHOICES.map(
								(minutes) => describeClear(minutes) + (minutes === DEFAULT_STATE.clearMinutes ? " (default)" : ""),
							);
							const picked = await ctx.ui.select("Clear after", labels, {
								initialIndex: Math.max(0, CLEAR_CHOICES.indexOf(state.clearMinutes)),
							});
							const minutes = CLEAR_CHOICES[labels.indexOf(picked ?? "")];
							if (minutes !== undefined) await applyGlobalState(writeGlobalState({ clearMinutes: minutes }));
						},
					},
				);
			}
			items.push({ label: "Done" });

			const choice = await ctx.ui.select("Discord presence settings", items, {
				initialIndex: Math.min(index, items.length - 1),
				helpText: projectScope
					? "Enter overrides a setting for this project, or returns it to the global value · Esc closes"
					: "Enter changes the setting · Esc closes",
			});
			const picked = items.find((item) => item.label === choice);
			if (!picked?.run) return; // Esc or Done
			index = items.indexOf(picked);
			await picked.run();
		}
	};

	pi.registerCommand("discord-presence", {
		description: `toggle Discord Rich Presence for all omp sessions, or hide/show this project's name. ${USAGE}`,
		// omp replaces the whole argument text with the chosen value, so "context o" completes to "context on".
		getArgumentCompletions: (argumentPrefix) => {
			const typed = argumentPrefix.trimStart().toLowerCase();
			const items = SUBCOMMANDS.filter(([value]) => value.startsWith(typed)).map(([value, description]) => ({
				value,
				label: value,
				description,
			}));
			return items.length > 0 ? items : null;
		},
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
		if (cwd !== ctx.cwd) {
			// A session switch can move to another repository: forget the previous git dir and its watcher.
			stopBranchWatch();
			gitDir = undefined;
		}
		cwd = ctx.cwd;
		watchGlobalState();
		const state = readGlobalState();
		({ enabled, hiddenProjects, awayMinutes, clearMinutes, autoHidePrivate, timer } = state);
		({ showContext, showModel, showButton, showBranch } = effectiveSettings(state, cwd));
		const key = projectKeyFor(cwd, state.projects);
		projectOverrides = key ? state.projects[key]! : {};
		updatePresence({
			status: "idle",
			model: ctx.model,
			contextPercent: readContextPercent(ctx),
			startedAt: Date.now(),
		});
		if (!sessionMarker) {
			sessionStartedAt = Date.now();
			registerSession();
		}
		// Discord hides the small (brand) image without a large one: start from the cached app icon, then refresh it.
		if (!app.name) {
			app = readCachedAppInfo();
			void fetchAppInfo()
				.then((info) => {
					if (!info.name) return; // Discord's API unreachable: keep the cached copy
					if (info.name === app.name && info.iconUrl === app.iconUrl) return;
					app = info;
					try {
						writeJsonAtomic(APP_CACHE_FILE, { clientId: CLIENT_ID, ...info });
					} catch {
						// Only costs the next session's first update its large image.
					}
					schedulePresenceUpdate();
				})
				.catch(() => {});
		}
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
		const lookupId = ++repoLookupId; // a later session_start (session switch) supersedes this lookup
		repoCheck = Promise.all([
			findPublicGithubRepo(ctx.cwd).then(({ lookup, revalidated }) => {
				if (lookupId !== repoLookupId) return;
				repo = lookup;
				// A cached answer was used; apply GitHub's fresh one if the repo changed visibility since.
				revalidated
					?.then((fresh) => {
						if (!fresh || lookupId !== repoLookupId) return;
						repo = fresh;
						schedulePresenceUpdate();
					})
					.catch(() => {});
			}),
			startBranchWatch(),
		]).then(schedulePresenceUpdate);
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
		if (showBranch) refreshBranch(); // backstop for filesystems where the HEAD watcher gets no events
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
		clearTimeout(clearTimer);
		stateWatcher?.close();
		stateWatcher = undefined;
		sessionsWatcher?.close();
		sessionsWatcher = undefined;
		if (sessionMarker) rmSync(sessionMarker, { force: true });
		sessionMarker = undefined;
		stopBranchWatch();
		await clearDiscordPresence();
		if (wslBridge) {
			wslBridge.close();
			rmSync(IPC_SOCKET_PATH, { force: true });
			wslBridge = undefined;
		}
	});
}
