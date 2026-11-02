import { afterEach, beforeEach, expect, test } from "bun:test";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { connectDiscordIpc } from "../extensions/discord-ipc.ts";
import { removeDir, tempDir } from "./support.ts";

// A Discord that misbehaves in the ways the real one may: split and merged frames, pings, refusals, drops.
// Each test gets its own socket dir, away from the fake Discord the presence tests share.
const realRuntimeDir = process.env.XDG_RUNTIME_DIR;
let runtimeDir: string;
let server: Server | undefined;

beforeEach(() => {
	runtimeDir = tempDir("odp-ipc-");
	process.env.XDG_RUNTIME_DIR = runtimeDir;
});
afterEach(() => {
	server?.close();
	server = undefined;
	process.env.XDG_RUNTIME_DIR = realRuntimeDir;
	removeDir(runtimeDir);
});

const frame = (op: number, data: unknown) => {
	const body = Buffer.from(JSON.stringify(data));
	const header = Buffer.alloc(8);
	header.writeInt32LE(op, 0);
	header.writeInt32LE(body.length, 4);
	return Buffer.concat([header, body]);
};

const READY = frame(1, { cmd: "DISPATCH", evt: "READY", data: { v: 1 } });

/** Serves `discord-ipc-0`, calling `onFrame` for every complete frame the client sends. */
const serve = (onFrame: (socket: Socket, op: number, data: { cmd?: string; nonce?: string } | string) => void) => {
	server = createServer((socket) => {
		let buffer = Buffer.alloc(0);
		socket.on("error", () => {});
		socket.on("data", (chunk: Buffer) => {
			buffer = Buffer.concat([buffer, chunk]);
			while (buffer.length >= 8 && buffer.length >= 8 + buffer.readInt32LE(4)) {
				const end = 8 + buffer.readInt32LE(4);
				onFrame(socket, buffer.readInt32LE(0), JSON.parse(buffer.subarray(8, end).toString()));
				buffer = buffer.subarray(end);
			}
		});
	});
	server.listen(join(runtimeDir, "discord-ipc-0"));
};

test("frames split across reads or merged into one are decoded, and pings are answered", async () => {
	const pongs: unknown[] = [];
	serve((socket, op, data) => {
		if (op === 0) {
			// READY in two pieces, the second glued to a ping.
			socket.write(READY.subarray(0, 5));
			setTimeout(() => socket.write(Buffer.concat([READY.subarray(5), frame(3, "ping-1")])), 20);
		} else if (op === 4) pongs.push(data);
		else if (op === 1 && typeof data === "object") {
			// An unrelated event and the answer, merged into one write.
			const event = frame(1, { cmd: "DISPATCH", evt: "ACTIVITY_JOIN", data: {} });
			socket.write(Buffer.concat([event, frame(1, { cmd: data.cmd, nonce: data.nonce, evt: null, data: null })]));
		}
	});

	const client = await connectDiscordIpc("123", () => {});
	await client.setActivity({ details: "hello" });
	expect(pongs).toEqual(["ping-1"]);
	client.close();
});

test("an error answer rejects the request", async () => {
	serve((socket, op, data) => {
		if (op === 0) socket.write(READY);
		else if (op === 1 && typeof data === "object") {
			socket.write(frame(1, { cmd: data.cmd, nonce: data.nonce, evt: "ERROR", data: { code: 4000, message: "bad activity" } }));
		}
	});
	const client = await connectDiscordIpc("123", () => {});
	await expect(client.setActivity({ details: "x" })).rejects.toThrow("bad activity");
	client.close();
});

test("connecting fails when Discord isn't running or refuses the handshake", async () => {
	await expect(connectDiscordIpc("123", () => {})).rejects.toThrow("not running");

	serve((socket, op) => {
		if (op === 0) socket.write(frame(2, { code: 4000, message: "Invalid Client ID" }));
	});
	await expect(connectDiscordIpc("123", () => {})).rejects.toThrow();
});

test("a dropped connection is reported once, but closing it ourselves is not", async () => {
	const sockets: Socket[] = [];
	serve((socket, op) => {
		if (op === 0) {
			sockets.push(socket);
			socket.write(READY);
		}
	});

	let drops = 0;
	await connectDiscordIpc("123", () => drops++);
	sockets[0]!.destroy(); // Discord quits
	const own = await connectDiscordIpc("123", () => drops++);
	own.close();
	await Bun.sleep(100);
	expect(drops).toBe(1);
	// Requests on a closed connection fail instead of hanging.
	await expect(own.setActivity(undefined)).rejects.toThrow("connection closed");
});
