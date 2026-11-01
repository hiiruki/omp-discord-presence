import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import DiscordRPC from "discord-rpc";
import { mkdirSync, readFileSync, renameSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, sep } from "node:path";

const CLIENT_ID = process.env.OMP_DISCORD_CLIENT_ID ?? "1566329796068384808";
const LARGE_IMAGE_KEY = process.env.OMP_DISCORD_LARGE_IMAGE_KEY;
const SMALL_IDLE_IMAGE_KEY = process.env.OMP_DISCORD_SMALL_IDLE_IMAGE_KEY;
const SMALL_WORKING_IMAGE_KEY = process.env.OMP_DISCORD_SMALL_WORKING_IMAGE_KEY;
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
	model?: string;
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

const USAGE = "usage: /discord-presence [on|off|status|refresh|hide|show]";

export default function discordPresence(pi: ExtensionAPI) {
	let rpc: DiscordRpcClient | undefined;
	let connected = false;
	let reconnectTimer: NodeJS.Timeout | undefined;
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
		const modelSuffix = presence.model ? ` · ${presence.model}` : "";
		const state = presence.toolName
			? `${presence.state} · ${presence.toolName}${modelSuffix}`
			: `${presence.state}${modelSuffix}`;
		const smallImageKey = presence.status === "idle" ? SMALL_IDLE_IMAGE_KEY : SMALL_WORKING_IMAGE_KEY;
		const project = projectHidden() ? PRIVATE_PROJECT_LABEL : normalizeProjectName(cwd);

		return {
			details: truncateDiscordText(`omp · ${project}`),
			state: truncateDiscordText(state),
			startTimestamp: new Date(presence.startedAt),
			largeImageKey: LARGE_IMAGE_KEY,
			largeImageText: LARGE_IMAGE_KEY ? "oh-my-pi coding agent" : undefined,
			smallImageKey,
			smallImageText: smallImageKey ? (presence.status === "idle" ? "idle" : "working") : undefined,
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
			model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
			startedAt: Date.now(),
		});
		if (enabled) void connect();
	});

	pi.on("agent_start", async (_event, ctx) => {
		updatePresence({
			status: "working",
			state: "thinking",
			toolName: undefined,
			model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
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
	});
}
