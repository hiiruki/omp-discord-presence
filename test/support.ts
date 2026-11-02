/**
 * Test doubles shared by the test files: a fake Discord IPC server, a stubbed network, and a fake omp
 * session that drives the extension the way omp does (events, commands, settings menu).
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** GitHub API status per `owner/repo`; unlisted repos are public (200). */
export const githubRepos = new Map<string, number>();
/** Art Asset keys the fake Discord application has uploaded. */
export const uploadedAssets = new Set<string>();

export type Activity = { details?: string; state?: string; party?: { size?: number[] }; buttons?: unknown[]; assets?: Record<string, string> };
/** Every SET_ACTIVITY in arrival order; `null` is a cleared activity. */
export const activities: (Activity | null)[] = [];

const realFetch = globalThis.fetch;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

/** Installs the network stub: the extension only talks to GitHub's and Discord's public APIs, never for real in tests. */
export const stubNetwork = () => {
	globalThis.fetch = (async (input: string | URL | Request) => {
		const url = String(input instanceof Request ? input.url : input);
		const repo = /api\.github\.com\/repos\/(.+)$/.exec(url)?.[1];
		if (repo) return json({}, githubRepos.get(repo) ?? 200);
		if (/discord\.com\/api\/v10\/applications\/\d+\/rpc$/.test(url)) return json({ name: "OH MY PI", icon: null });
		if (/discord\.com\/api\/v10\/oauth2\/applications\/\d+\/assets$/.test(url)) {
			return json([...uploadedAssets].map((name) => ({ name })));
		}
		throw new Error(`unexpected network request in tests: ${url}`);
	}) as typeof fetch;
	return () => {
		globalThis.fetch = realFetch;
	};
};

/** Fake Discord desktop IPC: answers the handshake and every command, recording activities. */
export const startFakeDiscord = (socketPath: string) => {
	const encode = (op: number, data: unknown) => {
		const body = Buffer.from(JSON.stringify(data));
		const header = Buffer.alloc(8);
		header.writeInt32LE(op, 0);
		header.writeInt32LE(body.length, 4);
		return Buffer.concat([header, body]);
	};
	const server = createServer((socket) => {
		let buffer = Buffer.alloc(0);
		socket.on("error", () => {});
		socket.on("data", (chunk) => {
			buffer = Buffer.concat([buffer, chunk]);
			while (buffer.length >= 8) {
				const op = buffer.readInt32LE(0);
				const length = buffer.readInt32LE(4);
				if (buffer.length < 8 + length) return;
				const message = JSON.parse(buffer.subarray(8, 8 + length).toString());
				buffer = buffer.subarray(8 + length);
				if (op === 0) {
					socket.write(encode(1, { cmd: "DISPATCH", evt: "READY", data: { v: 1, config: {}, user: { id: "1" } } }));
				} else if (op === 1) {
					if (message.cmd === "SET_ACTIVITY") activities.push(message.args?.activity ?? null);
					socket.write(encode(1, { cmd: message.cmd, nonce: message.nonce, evt: null, data: null }));
				}
			}
		});
	});
	server.listen(socketPath);
	return server;
};

/** Polls the recorded activities (from `since`) until one satisfies `predicate`. */
export const waitForActivity = async (
	predicate: (activity: Activity | null) => boolean,
	{ since = 0, timeout = 9_000 } = {},
): Promise<Activity | null> => {
	const deadline = Date.now() + timeout;
	for (;;) {
		const match = activities.slice(since).find(predicate);
		if (match !== undefined) return match;
		if (Date.now() > deadline) {
			throw new Error(`no matching activity within ${timeout} ms; last: ${JSON.stringify(activities.at(-1))}`);
		}
		await Bun.sleep(50);
	}
};

export const tempDir = (prefix: string) => mkdtempSync(join(tmpdir(), prefix));

/** A git repository whose origin is `https://github.com/<slug>.git`. */
export const githubRepo = (slug: string) => {
	const dir = join(tempDir("odp-repo-"), slug.split("/")[1]!);
	mkdirSync(dir, { recursive: true });
	// commit.gpgsign=false: a developer's global signing setting must not prompt during tests.
	const git = (...args: string[]) =>
		execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], {
			stdio: "ignore",
		});
	git("init", "-q", "-b", "main");
	git("remote", "add", "origin", `https://github.com/${slug}.git`);
	git("commit", "-q", "--allow-empty", "-m", "init");
	return dir;
};

export const removeDir = (dir: string) => rmSync(dir, { recursive: true, force: true });

type Handler = (event: unknown, ctx: unknown) => Promise<unknown> | unknown;
type Command = {
	handler: (args: string, ctx: unknown) => Promise<void>;
	getArgumentCompletions?: (prefix: string) => { value: string }[] | null;
};

/** A fake omp session running the extension, like omp does for the main session or a subagent. */
export const startSession = async ({
	cwd,
	kind = "main",
	model = { provider: "anthropic", id: "claude-opus-5-5" },
}: {
	cwd: string;
	kind?: "main" | "sub";
	model?: { provider: string; id: string };
}) => {
	const { default: factory } = await import("../extensions/discord-presence.ts");
	const handlers: Record<string, Handler> = {};
	let command: Command | undefined;
	const notes: string[] = [];
	/** Labels (prefixes) the settings menu picks next; it closes when the queue runs out. */
	const menuPicks: string[] = [];
	factory({
		on: (name: string, handler: Handler) => {
			handlers[name] = handler;
		},
		registerCommand: (_name: string, options: Command) => {
			command = options;
		},
		getThinkingLevel: () => "high",
	} as never);
	const ctx = {
		cwd,
		hasUI: true,
		agent: { kind },
		model,
		getContextUsage: () => ({ tokens: 4200, contextWindow: 200_000, percent: 2.1 }),
		setInterval: () => 0,
		clearTimer: () => {},
		ui: {
			notify: (message: string) => notes.push(message),
			select: async (_title: string, items: (string | { label: string })[]) => {
				const want = menuPicks.shift() ?? "Done";
				return items.map((item) => (typeof item === "string" ? item : item.label)).find((label) => label.startsWith(want));
			},
		},
	};
	const emit = async (name: string, event: Record<string, unknown> = {}) => {
		await handlers[name]?.({ type: name, ...event }, ctx);
	};
	await emit("session_start");
	return {
		emit,
		notes,
		run: (args: string) => command!.handler(args, ctx),
		settings: (...picks: string[]) => {
			menuPicks.push(...picks);
			return command!.handler("settings", ctx);
		},
		complete: (prefix: string) => command!.getArgumentCompletions?.(prefix)?.map((item) => item.value) ?? null,
		shutdown: () => emit("session_shutdown"),
	};
};
