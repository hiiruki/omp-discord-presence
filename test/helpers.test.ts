import { describe, expect, test } from "bun:test";
import {
	DEFAULT_STATE,
	effectiveSettings,
	formatDuration,
	GITHUB_REMOTE,
	type GlobalState,
	modelIconKey,
} from "../extensions/discord-presence.ts";

describe("GitHub origin parsing", () => {
	test.each([
		["https://github.com/acme/app.git", "acme/app"],
		["https://github.com/acme/app", "acme/app"],
		["https://github.com/acme/app/", "acme/app"],
		["git@github.com:acme/app.git", "acme/app"],
		["ssh://git@github.com/acme/app.git", "acme/app"],
		["https://github.com/acme/my.repo.js.git", "acme/my.repo.js"],
	])("%s -> %s", (remote, slug) => {
		expect(GITHUB_REMOTE.exec(remote)?.[1]).toBe(slug);
	});

	test("credentials in the remote never end up in the slug", () => {
		expect(GITHUB_REMOTE.exec("https://user:ghp_secret@github.com/acme/app.git")?.[1]).toBe("acme/app");
	});

	test.each(["https://gitlab.com/acme/app.git", "git@github-work:acme/app.git"])("%s is not GitHub", (remote) => {
		expect(GITHUB_REMOTE.exec(remote)).toBeNull();
	});
});

describe("model logo", () => {
	test.each([
		[{ provider: "anthropic", id: "claude-opus-5-5" }, "claude"],
		[{ provider: "github-copilot", id: "claude-sonnet-4.5" }, "claude"],
		[{ provider: "openrouter", id: "anthropic/claude-sonnet-4.5" }, "claude"],
		[{ provider: "openai", id: "gpt-5.1" }, "openai"],
		[{ provider: "openai", id: "o3-mini" }, "openai"],
		[{ provider: "google", id: "gemini-3-pro" }, "gemini"],
		[{ provider: "deepseek", id: "deepseek-chat" }, "deepseek"],
		[{ provider: "groq", id: "llama-3.3-70b" }, "meta"],
	])("%o -> %s (model id wins over the provider)", (model, key) => {
		expect(modelIconKey(model)).toBe(key);
	});

	test("falls back to the provider when no model rule matches", () => {
		expect(modelIconKey({ provider: "deepinfra", id: "some-unknown-model" })).toBe("deepinfra");
	});

	test("unknown model and provider get no logo", () => {
		expect(modelIconKey({ provider: "acme-local", id: "space-bunny" })).toBeUndefined();
	});
});

describe("per-project settings", () => {
	const state: GlobalState = {
		...DEFAULT_STATE,
		showBranch: false,
		projects: {
			"/work/client": { showButton: false, showBranch: true },
			"/work/client/packages/api": { showModel: false },
		},
	};

	test("a project overrides only the settings it lists", () => {
		expect(effectiveSettings(state, "/work/client")).toEqual({
			showModel: true,
			showButton: false,
			showBranch: true,
			showContext: false,
		});
	});

	test("the closest project wins; it does not inherit its parent's overrides", () => {
		expect(effectiveSettings(state, "/work/client/packages/api/src")).toEqual({
			showModel: false,
			showButton: true,
			showBranch: false,
			showContext: false,
		});
	});

	test("a sibling folder sharing a name prefix is not covered", () => {
		expect(effectiveSettings(state, "/work/client-old")).toEqual({
			showModel: true,
			showButton: true,
			showBranch: false,
			showContext: false,
		});
	});
});

describe("durations", () => {
	test.each([
		[0, "0s"],
		[59_400, "59s"],
		[59_600, "1m 0s"],
		[899_700, "15m 0s"],
		[125_400, "2m 5s"],
		[3_599_600, "1h 0m"],
		[5_430_000, "1h 30m"],
		[7_200_000, "2h 0m"],
	])("%d ms -> %s", (ms, text) => {
		expect(formatDuration(ms)).toBe(text);
	});
});
