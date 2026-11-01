import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import DiscordRPC from "discord-rpc";
// Resolved by omp's loader to the running host, so this is the installed omp version, not a bundled copy.
import { VERSION } from "@oh-my-pi/pi-utils";
import { execFile, spawn } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { createConnection, createServer, type Server } from "node:net";
import { homedir, release } from "node:os";
import { basename, dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const CLIENT_ID = process.env.OMP_DISCORD_CLIENT_ID ?? "1566329796068384808";
const LARGE_IMAGE_KEY = process.env.OMP_DISCORD_LARGE_IMAGE_KEY;
// Values are Discord Art Asset keys: upload assets/models/<key>.png to the app under the same name.
// Matched against the model id first (Claude via OpenRouter/Copilot still shows Claude), then the provider.
const BRAND_ICONS: [RegExp, string][] = [
	[/claude|anthropic/, "claude"],
	[/gpt|^o\d|codex|openai/, "openai"],
	[/gemini|gemma|google/, "gemini"],
	[/deepseek/, "deepseek"],
	[/grok|xai/, "xai"],
	[/stral|mixtral/, "mistral"],
	[/qwen|qwq/, "qwen"],
	[/kimi|moonshot/, "moonshot"],
	[/glm|zhipu|zai/, "zhipu"],
	[/minimax/, "minimax"],
	[/(?<!o)llama/, "meta"],
	[/openrouter/, "openrouter"],
	[/copilot/, "githubcopilot"],
	[/ollama/, "ollama"],
	[/groq/, "groq"],
	[/cerebras/, "cerebras"],
	[/bedrock/, "bedrock"],
];
const GLOBAL_STATE_FILE = join(homedir(), ".omp", "agent", "discord-presence-state.json");
const RECONNECT_DELAY_MS = 15_000;
const PRESENCE_UPDATE_DEBOUNCE_MS = 750;
const DISCORD_TEXT_LIMIT = 128;
const PRIVATE_PROJECT_LABEL = "private project";

type PresenceStatus = "idle" | "working" | "tool" | "offline";

type PresenceState = {
	status: PresenceStatus;
	state: string;
	toolName?: string;
	model?: { provider: string; id: string };
	startedAt: number;
};

type GlobalState = {
	enabled: boolean;
	/** Absolute project paths whose name is never sent to Discord (subdirectories included). */
	hiddenProjects: string[];
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
		const parsed = JSON.parse(readFileSync(GLOBAL_STATE_FILE, "utf8")) as { enabled?: unknown; hiddenProjects?: unknown };
		return {
			enabled: parsed.enabled !== false,
			hiddenProjects: Array.isArray(parsed.hiddenProjects)
				? parsed.hiddenProjects.filter((project): project is string => typeof project === "string")
				: [],
		};
	} catch {
		return { enabled: true, hiddenProjects: [] };
	}
};

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

const USAGE = "usage: /discord-presence [on|off|status|refresh|hide|show]";

export default function discordPresence(pi: ExtensionAPI) {
	let rpc: DiscordRpcClient | undefined;
	let connected = false;
	let reconnectTimer: NodeJS.Timeout | undefined;
	let appIconUrl: string | undefined;
	let repoUrl: string | undefined;
	let wslBridge: Server | undefined;
	let updateTimer: NodeJS.Timeout | undefined;
	let stateWatcher: FSWatcher | undefined;
	let shuttingDown = false;
	let { enabled, hiddenProjects } = readGlobalState();
	let cwd = process.cwd();

	let presence: PresenceState = {
		status: "offline",
		state: "starting discord rich presence",
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
		const model = presence.model && `${presence.model.provider}/${presence.model.id}`;
		const effort = pi.getThinkingLevel();
		const modelInfo = model && (effort && effort !== "inherit" ? `${model} · effort: ${effort}` : model);
		const modelSuffix = modelInfo ? ` · ${modelInfo}` : "";
		const state = presence.toolName
			? `${presence.state} · ${presence.toolName}${modelSuffix}`
			: `${presence.state}${modelSuffix}`;
		const id = presence.model?.id.toLowerCase() ?? "";
		const provider = presence.model?.provider.toLowerCase() ?? "";
		const brand =
			BRAND_ICONS.find(([pattern]) => pattern.test(id)) ?? BRAND_ICONS.find(([pattern]) => pattern.test(provider));
		const hidden = projectHidden();
		const project = hidden ? PRIVATE_PROJECT_LABEL : normalizeProjectName(cwd);
		const largeImageKey = LARGE_IMAGE_KEY ?? appIconUrl;

		return {
			details: truncateDiscordText(`omp v${VERSION} · ${project}`),
			state: truncateDiscordText(state),
			startTimestamp: new Date(presence.startedAt),
			largeImageKey,
			largeImageText: largeImageKey ? `oh-my-pi coding agent v${VERSION}` : undefined,
			smallImageKey: brand?.[1],
			smallImageText: brand && modelInfo,
			// Discord never shows your own buttons to you; other people see them on your profile.
			buttons: repoUrl && !hidden ? [{ label: "View on GitHub", url: repoUrl }] : undefined,
			instance: false,
		};
	};

	const flushPresence = async () => {
		clearUpdateTimer();
		if (!connected || !rpc || !enabled || shuttingDown) return;

		try {
			await rpc.setActivity(buildActivity());
		} catch {
			connected = false;
			scheduleReconnect();
		}
	};

	const schedulePresenceUpdate = () => {
		if (updateTimer) return;
		updateTimer = setTimeout(() => void flushPresence(), PRESENCE_UPDATE_DEBOUNCE_MS);
	};

	const updatePresence = (patch: Partial<PresenceState>) => {
		presence = { ...presence, ...patch };
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
		if (projectHidden() !== wasHidden) await flushPresence();

		if (enabled === next.enabled) return;
		enabled = next.enabled;

		if (!enabled) {
			await clearDiscordPresence();
			return;
		}

		updatePresence({
			status: "idle",
			state: "idle",
			toolName: undefined,
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
			const action = args.trim().toLowerCase() || (enabled ? "off" : "on");

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
				case "status":
					ctx.ui.notify(
						`discord presence: ${enabled ? "enabled globally" : "disabled globally"}, ${connected ? "connected" : "not connected"}, project ${projectHidden() ? "hidden" : "visible"}`,
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
		if (ctx.agent.kind !== "main") return;
		shuttingDown = false;
		cwd = ctx.cwd;
		watchGlobalState();
		({ enabled, hiddenProjects } = readGlobalState());
		updatePresence({
			status: "idle",
			state: "idle",
			model: ctx.model,
			startedAt: Date.now(),
		});
		// Discord hides the small (brand) image without a large one; default to the app's own icon.
		if (!LARGE_IMAGE_KEY && !appIconUrl) void fetchAppIconUrl().then((url) => {
			appIconUrl = url;
			schedulePresenceUpdate();
		});
		repoUrl = undefined;
		void findPublicGithubRepo(ctx.cwd).then((url) => {
			repoUrl = url;
			if (url) schedulePresenceUpdate();
		});
		if (enabled) void connect();
	});

	pi.on("agent_start", async (_event, ctx) => {
		updatePresence({
			status: "working",
			state: "thinking",
			toolName: undefined,
			model: ctx.model,
			startedAt: Date.now(),
		});
	});

	pi.on("tool_execution_start", async (event) => {
		updatePresence({
			status: "tool",
			state: "using tool",
			toolName: event.toolName,
		});
	});

	pi.on("tool_execution_end", async () => {
		updatePresence({
			status: "working",
			state: "thinking",
			toolName: undefined,
		});
	});

	pi.on("agent_end", async () => {
		updatePresence({
			status: "idle",
			state: "idle",
			toolName: undefined,
		});
	});

	pi.on("session_shutdown", async () => {
		shuttingDown = true;
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
