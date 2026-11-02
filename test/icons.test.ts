import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { MODEL_ICON_RULES, PROVIDER_ICON_RULES } from "../extensions/model-icons.generated.ts";

const ASSETS = join(import.meta.dir, "../assets/models");
const shipped = new Set(readdirSync(ASSETS).map((file) => file.replace(/\.png$/, "")));
const ruleKeys = new Set(
	[...MODEL_ICON_RULES, ...PROVIDER_ICON_RULES].flatMap(([, key]) => (key === null ? [] : [key])),
);

describe("generated model logos", () => {
	test("every logo key a rule can send has a PNG to upload as an Art Asset", () => {
		expect([...ruleKeys].filter((key) => !shipped.has(key))).toEqual([]);
	});

	test("every shipped PNG is reachable from a rule", () => {
		expect([...shipped].filter((key) => !ruleKeys.has(key))).toEqual([]);
	});

	test("stays under Discord's 300 Art Assets per application", () => {
		expect(shipped.size).toBeLessThanOrEqual(300);
	});

	test("every PNG meets Discord's 512×512 minimum", () => {
		const tooSmall = [...shipped].filter((key) => {
			const png = readFileSync(join(ASSETS, `${key}.png`));
			return png.readUInt32BE(16) < 512 || png.readUInt32BE(20) < 512;
		});
		expect(tooSmall).toEqual([]);
	});
});
