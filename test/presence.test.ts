import { getAgentDir } from "@oh-my-pi/pi-utils";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	activities,
	githubRepo,
	githubRepos,
	removeDir,
	startSession,
	tempDir,
	waitForActivity,
} from "./support.ts";

// Activity updates are spaced 4 s apart (Discord's rate limit), so each step can take that long.
const TIMEOUT = 40_000;
const STATE_FILE = join(getAgentDir(), "discord-presence-state.json");

let cleanups: (() => unknown)[] = [];
const track = <T extends { shutdown: () => unknown }>(session: T) => {
	cleanups.push(session.shutdown);
	return session;
};

beforeEach(() => {
	rmSync(STATE_FILE, { force: true });
	githubRepos.clear();
	activities.length = 0; // each test only sees activities sent during it
});
afterEach(async () => {
	for (const cleanup of cleanups.reverse()) await cleanup();
	cleanups = [];
});

describe("status", () => {
	test(
		"shows omp version, project, model and effort, then follows the agent loop",
		async () => {
			const dir = tempDir("odp-plain-");
			const session = track(await startSession({ cwd: dir }));
			const name = dir.split("/").at(-1)!;

			const idle = await waitForActivity((a) => a?.state?.startsWith("idle") === true);
			expect(idle?.details).toMatch(new RegExp(`^omp v\\S+ · ${name}$`));
			expect(idle?.state).toBe("idle · anthropic/claude-opus-5-5 · effort: high");
			expect(idle?.assets?.small_image).toBe("claude");

			// Two tools in parallel: "using tool" holds until the last one ends.
			let mark = activities.length;
			await session.emit("agent_start");
			await session.emit("tool_execution_start", { toolCallId: "a", toolName: "bash" });
			await session.emit("tool_execution_start", { toolCallId: "b", toolName: "read" });
			await session.emit("tool_execution_end", { toolCallId: "a", toolName: "bash" });
			await waitForActivity((a) => a?.state?.startsWith("using tool · read") === true, { since: mark });

			mark = activities.length;
			await session.emit("tool_execution_end", { toolCallId: "b", toolName: "read" });
			await session.emit("agent_end");
			await waitForActivity((a) => a?.state?.startsWith("idle") === true, { since: mark });
			removeDir(dir);
		},
		TIMEOUT,
	);

	test(
		"waiting for an approval outranks the running tool and never sends the reason",
		async () => {
			const dir = tempDir("odp-approval-");
			const session = track(await startSession({ cwd: dir }));
			await waitForActivity((a) => a?.state?.startsWith("idle") === true);

			const mark = activities.length;
			await session.emit("agent_start");
			await session.emit("tool_execution_start", { toolCallId: "t", toolName: "bash" });
			await session.emit("tool_approval_requested", { toolCallId: "t", toolName: "bash", reason: "rm -rf ~/secret-dir" });
			await waitForActivity((a) => a?.state?.startsWith("waiting for approval · bash") === true, { since: mark });

			await session.emit("tool_approval_resolved", { toolCallId: "t", toolName: "bash", approved: true });
			await waitForActivity((a) => a?.state?.startsWith("using tool · bash") === true, { since: mark });
			expect(JSON.stringify(activities)).not.toContain("secret-dir");
			removeDir(dir);
		},
		TIMEOUT,
	);

	test(
		"turning the presence off clears the activity",
		async () => {
			const dir = tempDir("odp-off-");
			const session = track(await startSession({ cwd: dir }));
			await waitForActivity((a) => a?.state?.startsWith("idle") === true);

			const mark = activities.length;
			await session.run("off");
			await waitForActivity((a) => a === null, { since: mark });
			removeDir(dir);
		},
		TIMEOUT,
	);
});

describe("privacy", () => {
	test(
		"a private GitHub repo's name is never sent",
		async () => {
			githubRepos.set("acme/secret-client", 404);
			const dir = githubRepo("acme/secret-client");
			track(await startSession({ cwd: dir }));
			const mark = 0;

			const first = await waitForActivity((a) => a !== null, { since: mark });
			expect(first?.details).toMatch(/· private project$/);
			expect(first?.buttons).toBeUndefined();
			expect(JSON.stringify(activities.slice(mark))).not.toContain("secret-client");
			removeDir(dir);
		},
		TIMEOUT,
	);

	test(
		"a public repo gets the GitHub button, and hide removes name and button",
		async () => {
			const dir = githubRepo("acme/open-thing");
			let mark = activities.length;
			const session = track(await startSession({ cwd: dir }));

			const shown = await waitForActivity((a) => a !== null, { since: mark });
			expect(shown?.details).toMatch(/· open-thing$/);
			expect(shown?.buttons).toEqual([{ label: "View on GitHub", url: "https://github.com/acme/open-thing" }]);

			mark = activities.length;
			await session.run("hide");
			const hidden = await waitForActivity((a) => a?.details?.endsWith("private project") === true, { since: mark });
			expect(hidden?.buttons).toBeUndefined();
			removeDir(dir);
		},
		TIMEOUT,
	);
});

describe("settings", () => {
	test(
		"a per-project override applies to that project and its subdirectories only",
		async () => {
			const work = githubRepo("acme/work-repo");
			const hobby = githubRepo("acme/hobby-repo");
			const api = join(work, "packages/api");
			mkdirSync(api, { recursive: true });
			const workSession = track(await startSession({ cwd: work }));
			track(await startSession({ cwd: api }));
			track(await startSession({ cwd: hobby }));
			await waitForActivity((a) => a?.details?.endsWith("· hobby-repo") === true);

			// In work-repo: switch the menu to "this project", hide the button and show the branch.
			const mark = activities.length;
			await workSession.settings("Editing", "GitHub button", "Git branch");
			const workNow = await waitForActivity((a) => a?.details?.endsWith("work-repo @ main") === true, { since: mark });
			expect(workNow?.buttons).toBeUndefined();
			// The subdirectory session picks the overrides up live, through the shared settings file.
			const apiNow = await waitForActivity((a) => a?.details?.endsWith("api @ main") === true, { since: mark });
			expect(apiNow?.buttons).toBeUndefined();

			// hobby-repo keeps the global settings.
			const hobbyNow = activities.filter((a) => a?.details?.includes("hobby-repo")).at(-1);
			expect(hobbyNow?.details).toMatch(/· hobby-repo$/);
			expect(hobbyNow?.buttons).toHaveLength(1);
			removeDir(work);
			removeDir(hobby);
		},
		TIMEOUT,
	);
});

describe("subagents", () => {
	test(
		"running subagents show as a party that shrinks as they finish",
		async () => {
			const dir = tempDir("odp-party-");
			const main = track(await startSession({ cwd: dir }));
			await waitForActivity((a) => a?.state?.startsWith("idle") === true);
			await main.emit("agent_start");
			await main.emit("tool_execution_start", { toolCallId: "t", toolName: "task" });

			let mark = activities.length;
			const subs = await Promise.all([1, 2, 3].map(() => startSession({ cwd: dir, kind: "sub" })));
			for (const sub of subs) await sub.emit("agent_start");
			await waitForActivity((a) => a?.party?.size?.join("/") === "4/4", { since: mark });

			mark = activities.length;
			await subs[0]!.emit("agent_end");
			await subs[1]!.shutdown(); // stopped mid-run, never reaches agent_end
			await waitForActivity((a) => a?.party?.size?.join("/") === "2/4", { since: mark });

			mark = activities.length;
			await subs[2]!.emit("agent_end");
			// The party disappears while the main agent is still in the task tool. Scoped to this project so a stray
			// frame from another session can't satisfy it; on timeout the error shows the last activity.
			const name = dir.split("/").at(-1)!;
			await waitForActivity(
				(a) => a?.details?.endsWith(name) === true && a.party === undefined && a.state?.startsWith("using tool · task") === true,
				{ since: mark },
			);
			removeDir(dir);
		},
		TIMEOUT,
	);
});

describe("timer and hover", () => {
	test(
		"the timer restarts with each prompt by default, and stays at the session start when set to session",
		async () => {
			const dir = tempDir("odp-timer-");
			const name = dir.split("/").at(-1)!;
			const session = track(await startSession({ cwd: dir }));
			const first = await waitForActivity((a) => a?.state?.startsWith("idle") === true);
			const sessionStart = first!.timestamps!.start!;

			// Per prompt (default): agent_start moves the start forward. The first update already waited out the
			// 0.75 s debounce, so the prompt starts strictly later than the session.
			let mark = activities.length;
			await session.emit("agent_start");
			const prompt = await waitForActivity((a) => a?.state?.startsWith("thinking") === true, { since: mark });
			expect(prompt!.timestamps!.start!).toBeGreaterThan(sessionStart);

			// Switched to per session from the settings menu: back to the session start, and prompts no longer move it.
			mark = activities.length;
			await session.settings("Timer");
			await waitForActivity((a) => a?.details?.endsWith(name) === true && a.timestamps?.start === sessionStart, {
				since: mark,
			});
			mark = activities.length;
			await session.emit("agent_end");
			await session.emit("agent_start");
			const later = await waitForActivity((a) => a?.state?.startsWith("thinking") === true, { since: mark });
			expect(later!.timestamps!.start).toBe(sessionStart);
			removeDir(dir);
		},
		TIMEOUT,
	);

	test(
		"the large image hover counts open omp sessions and ignores ones that crashed",
		async () => {
			const sessionsDir = join(getAgentDir(), "discord-presence-sessions");
			mkdirSync(sessionsDir, { recursive: true });
			const crashed = join(sessionsDir, "999999999-1"); // a pid no process can have
			writeFileSync(crashed, "");

			const dirA = tempDir("odp-hover-a-");
			const dirB = tempDir("odp-hover-b-");
			track(await startSession({ cwd: dirA }));
			const b = await startSession({ cwd: dirB });
			await waitForActivity((a) => a?.assets?.large_text?.endsWith("· 2 sessions open") === true);
			expect(existsSync(crashed)).toBe(false);

			const mark = activities.length;
			await b.shutdown();
			await waitForActivity((a) => a?.assets?.large_text?.endsWith("· 1 session open") === true, { since: mark });
			expect(activities.at(-1)?.assets?.large_text).toMatch(/^oh-my-pi v\S+ · 1 session open$/);
			removeDir(dirA);
			removeDir(dirB);
		},
		TIMEOUT,
	);
});

describe("command", () => {
	test("Tab completion lists subcommands and narrows on partial input", async () => {
		const dir = tempDir("odp-complete-");
		const session = track(await startSession({ cwd: dir }));
		expect(session.complete("")).toEqual(expect.arrayContaining(["settings", "status", "hide", "show", "context on"]));
		expect(session.complete("context o")).toEqual(["context on", "context off"]);
		expect(session.complete("zzz")).toBeNull();
		removeDir(dir);
	});
});
