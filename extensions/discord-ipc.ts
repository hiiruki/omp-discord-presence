// Just enough of the Discord desktop app's local RPC protocol to set an activity: handshake, SET_ACTIVITY, ping and
// close. Frames are a little-endian int32 opcode and length, then JSON.
import { randomUUID } from "node:crypto";
import { createConnection, type Socket } from "node:net";
import { join } from "node:path";

const OP = { HANDSHAKE: 0, FRAME: 1, CLOSE: 2, PING: 3, PONG: 4 } as const;
const CONNECT_TIMEOUT_MS = 10_000;
// Without it a Discord that stops answering would hang the clear on session shutdown.
const REQUEST_TIMEOUT_MS = 5_000;

/** The SET_ACTIVITY payload, as Discord takes it. */
export type Activity = {
	details?: string;
	state?: string;
	timestamps?: { start: number };
	assets?: { large_image?: string; large_text?: string; small_image?: string; small_text?: string };
	buttons?: { label: string; url: string }[];
	party?: { size: [number, number] };
	instance?: boolean;
};

export type DiscordIpcClient = {
	/** Sets this process's activity; `undefined` clears it. */
	setActivity: (activity: Activity | undefined) => Promise<void>;
	/** Closes the connection without waiting; never throws, and doesn't fire `onClose`. */
	close: () => void;
};

type Message = { cmd?: string; evt?: string | null; nonce?: string; data?: { message?: string } | null };

/** Where Discord listens: a named pipe on Windows, a Unix socket elsewhere. It takes the first free id of 0-9. */
export const discordIpcPath = (id: number) => {
	if (process.platform === "win32") return `\\\\?\\pipe\\discord-ipc-${id}`;
	const { XDG_RUNTIME_DIR, TMPDIR, TMP, TEMP } = process.env;
	return join(XDG_RUNTIME_DIR || TMPDIR || TMP || TEMP || "/tmp", `discord-ipc-${id}`);
};

const encode = (op: number, data: unknown) => {
	const body = Buffer.from(JSON.stringify(data));
	const header = Buffer.alloc(8);
	header.writeInt32LE(op, 0);
	header.writeInt32LE(body.length, 4);
	return Buffer.concat([header, body]);
};

// The error handler stays attached for the socket's life: an unhandled 'error' event would crash omp.
const openSocket = (path: string) =>
	new Promise<Socket | undefined>((resolve) => {
		const socket = createConnection(path, () => resolve(socket));
		socket.on("error", () => resolve(undefined));
	});

/**
 * Connects to the Discord desktop app and completes the handshake. Rejects when Discord isn't running, refuses the
 * client id, or doesn't answer within 10 s. `onClose` fires once if the established connection drops.
 */
export const connectDiscordIpc = async (clientId: string, onClose: () => void): Promise<DiscordIpcClient> => {
	let found: Socket | undefined;
	for (let id = 0; id < 10 && !found; id++) found = await openSocket(discordIpcPath(id));
	if (!found) throw new Error("Discord is not running");
	const socket = found;

	const pending = new Map<string, { resolve: () => void; reject: (error: Error) => void }>();
	let ready = false;
	let closedByUs = false;
	let buffer = Buffer.alloc(0);

	const client: DiscordIpcClient = {
		setActivity: (activity) =>
			new Promise((resolve, reject) => {
				if (socket.destroyed) return reject(new Error("connection closed"));
				const nonce = randomUUID();
				const timer = setTimeout(() => {
					pending.delete(nonce);
					reject(new Error("Discord did not answer"));
				}, REQUEST_TIMEOUT_MS);
				timer.unref();
				pending.set(nonce, {
					resolve: () => {
						clearTimeout(timer);
						resolve();
					},
					reject: (error) => {
						clearTimeout(timer);
						reject(error);
					},
				});
				socket.write(encode(OP.FRAME, { cmd: "SET_ACTIVITY", args: { pid: process.pid, activity }, nonce }));
			}),
		close: () => {
			closedByUs = true;
			if (!socket.destroyed) socket.write(encode(OP.CLOSE, {}), () => socket.destroy());
		},
	};

	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => socket.destroy(), CONNECT_TIMEOUT_MS);
		timeout.unref();

		socket.on("close", () => {
			clearTimeout(timeout);
			for (const request of pending.values()) request.reject(new Error("connection closed"));
			pending.clear();
			if (!ready) reject(new Error("Discord closed the connection"));
			else if (!closedByUs) onClose();
		});

		socket.on("data", (chunk: Buffer) => {
			buffer = Buffer.concat([buffer, chunk]);
			while (buffer.length >= 8) {
				const op = buffer.readInt32LE(0);
				const length = buffer.readInt32LE(4);
				if (length < 0) return void socket.destroy();
				if (buffer.length < 8 + length) return; // the rest of the frame is still on its way
				let message: Message;
				try {
					message = JSON.parse(buffer.subarray(8, 8 + length).toString()) as Message;
				} catch {
					return void socket.destroy(); // not Discord, or a corrupt stream
				}
				buffer = buffer.subarray(8 + length);

				if (op === OP.PING) socket.write(encode(OP.PONG, message));
				else if (op === OP.CLOSE) return void socket.destroy(); // Discord refused the handshake or is shutting down
				else if (op !== OP.FRAME) continue;
				else if (message.cmd === "DISPATCH" && message.evt === "READY") {
					ready = true;
					clearTimeout(timeout);
					resolve(client);
				} else {
					const request = message.nonce ? pending.get(message.nonce) : undefined;
					if (!request) continue;
					pending.delete(message.nonce!);
					if (message.evt === "ERROR") request.reject(new Error(message.data?.message ?? "Discord error"));
					else request.resolve();
				}
			}
		});

		socket.write(encode(OP.HANDSHAKE, { v: 1, client_id: clientId }));
	});
};
