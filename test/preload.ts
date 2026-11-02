/**
 * Runs before every test file (bunfig.toml). The extension resolves its settings file and Discord socket when it
 * is imported, so both are pointed at throwaway directories here, before anything imports it.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFakeDiscord, stubNetwork } from "./support.ts";

// Settings live in omp's agent dir. Bun's os.homedir() ignores a changed HOME, so override the agent dir itself.
const agentDir = mkdtempSync(join(tmpdir(), "odp-agent-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
delete process.env.PI_PROFILE;
process.env.XDG_RUNTIME_DIR = mkdtempSync(join(tmpdir(), "odp-run-"));
delete process.env.OMP_DISCORD_LARGE_IMAGE_KEY;

// Refuse to run if the override didn't take: tests write settings and must never touch the real file.
const { getAgentDir } = await import("@oh-my-pi/pi-utils");
if (getAgentDir() !== agentDir) {
	throw new Error(`tests would use the real omp agent dir (${getAgentDir()}); refusing to run`);
}

stubNetwork();
startFakeDiscord(join(process.env.XDG_RUNTIME_DIR, "discord-ipc-0")).unref();
