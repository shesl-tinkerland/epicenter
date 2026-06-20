/**
 * Test harness for the `Room` Durable Object.
 *
 * Bun's test runtime does not provide Cloudflare Workers globals, so this module
 * mocks `cloudflare:workers` (the DurableObject base class), shims
 * `WebSocketPair` / `WebSocket` / `WebSocketRequestResponsePair`, and provides an
 * in-memory `ctx` stub. It drives the real `Room` through its public `fetch()`
 * and `webSocketMessage()` surfaces, so tests exercise the actual relay, not a
 * reimplementation.
 *
 * Importing this module registers the `cloudflare:workers` mock and the global
 * shims as a side effect, so it must be imported before any code that resolves
 * `cloudflare:workers`. It only makes sense under `bun test`.
 *
 * Used by `durable-object.test.ts` (the relay's own tests) and
 * `vault-sync.integration.test.ts` (the secret vault's live-sync proof).
 */

import { expect, mock } from 'bun:test';
import * as encoding from 'lib0/encoding';

// ────────────────────────────────────────────────────────────────────────────
// CLOUDFLARE WORKERS SHIMS
// ────────────────────────────────────────────────────────────────────────────

// `WebSocket` is a host global in real Workers but Bun ships its own
// WebSocket class without a `WebSocketPair`. Provide a minimal stub good
// enough for the Room's send/close/readyState surface.
export class StubWebSocket {
	static readonly OPEN = 1;
	static readonly CLOSING = 2;
	static readonly CLOSED = 3;

	readyState: number = StubWebSocket.OPEN;
	sent: Array<Uint8Array | string> = [];
	closeCalls: Array<{ code: number; reason: string }> = [];
	private attachment: unknown = null;
	private failOnSend = false;

	send(data: Uint8Array | string): void {
		if (this.failOnSend) throw new Error('wedged');
		if (this.readyState !== StubWebSocket.OPEN) {
			throw new Error('socket not open');
		}
		this.sent.push(data);
	}

	close(code: number, reason: string): void {
		this.closeCalls.push({ code, reason });
		this.readyState = StubWebSocket.CLOSED;
	}

	serializeAttachment(value: unknown): void {
		this.attachment = value;
	}

	deserializeAttachment(): unknown {
		return this.attachment;
	}

	// Test-only: simulate a wedged peer whose `send` always throws.
	__wedge(): void {
		this.failOnSend = true;
	}

	// Test-only: pull text frames out of `sent`.
	textFrames(): string[] {
		return this.sent.filter((f): f is string => typeof f === 'string');
	}
}

export class StubWebSocketPair {
	0: StubWebSocket;
	1: StubWebSocket;
	constructor() {
		this[0] = new StubWebSocket();
		this[1] = new StubWebSocket();
	}
}

// biome-ignore lint/suspicious/noExplicitAny: globalThis shim
(globalThis as any).WebSocket ??= StubWebSocket;
// biome-ignore lint/suspicious/noExplicitAny: globalThis shim
(globalThis as any).WebSocketPair ??= StubWebSocketPair;

// `cloudflare:workers` is not resolvable in Bun. Mock it with a barebones
// DurableObject base class that records `ctx` and `env` so Room's
// constructor can run.
mock.module('cloudflare:workers', () => ({
	DurableObject: class {
		ctx: unknown;
		env: unknown;
		constructor(ctx: unknown, env: unknown) {
			this.ctx = ctx;
			this.env = env;
		}
	},
}));

// ────────────────────────────────────────────────────────────────────────────
// DURABLE OBJECT CTX STUB
// ────────────────────────────────────────────────────────────────────────────

type SqlRow = { id: number; data: ArrayBuffer };

/**
 * In-memory SQL surface that satisfies the subset of `ctx.storage.sql`
 * the Room touches: schema DDL, SELECT all updates, INSERT, DELETE,
 * COUNT, and `databaseSize`.
 */
export function makeSqlStorage() {
	const updates: SqlRow[] = [];
	let nextId = 1;

	function exec(
		query: string,
		...params: unknown[]
	): { toArray(): SqlRow[]; one(): { count: number } } {
		const q = query.trim().toUpperCase();
		if (q.startsWith('CREATE TABLE')) {
			return { toArray: () => [], one: () => ({ count: 0 }) };
		}
		if (q.startsWith('SELECT DATA FROM UPDATES')) {
			return {
				toArray: () => [...updates],
				one: () => ({ count: updates.length }),
			};
		}
		if (q.startsWith('SELECT COUNT(*)')) {
			return {
				toArray: () => [],
				one: () => ({ count: updates.length }),
			};
		}
		if (q.startsWith('INSERT INTO UPDATES')) {
			const blob = params[0] as Uint8Array;
			const copy = new ArrayBuffer(blob.byteLength);
			new Uint8Array(copy).set(blob);
			updates.push({ id: nextId++, data: copy });
			return { toArray: () => [], one: () => ({ count: 0 }) };
		}
		if (q.startsWith('DELETE FROM UPDATES')) {
			updates.length = 0;
			return { toArray: () => [], one: () => ({ count: 0 }) };
		}
		throw new Error(`Unsupported SQL: ${query}`);
	}

	return {
		exec,
		get databaseSize() {
			return updates.reduce((acc, r) => acc + r.data.byteLength, 0);
		},
		transactionSync(fn: () => void) {
			fn();
		},
	};
}

export function makeStorage() {
	let alarm: number | null = null;
	return {
		sql: makeSqlStorage(),
		async setAlarm(when: number) {
			alarm = when;
		},
		async getAlarm() {
			return alarm;
		},
		async deleteAlarm() {
			alarm = null;
		},
		async deleteAll() {},
	};
}

export type StubCtx = {
	storage: ReturnType<typeof makeStorage>;
	acceptedSockets: StubWebSocket[];
	acceptWebSocket(ws: StubWebSocket): void;
	getWebSockets(): StubWebSocket[];
	blockConcurrencyWhile(fn: () => Promise<unknown>): Promise<void>;
	setWebSocketAutoResponse(_pair: unknown): void;
};

export function makeCtx(): StubCtx {
	const acceptedSockets: StubWebSocket[] = [];
	return {
		storage: makeStorage(),
		acceptedSockets,
		acceptWebSocket(ws: StubWebSocket) {
			acceptedSockets.push(ws);
		},
		getWebSockets() {
			return acceptedSockets.slice();
		},
		async blockConcurrencyWhile(fn: () => Promise<unknown>) {
			await fn();
		},
		setWebSocketAutoResponse(_pair: unknown) {},
	};
}

// `WebSocketRequestResponsePair` is a global constructor in real Workers.
// biome-ignore lint/suspicious/noExplicitAny: globalThis shim
(globalThis as any).WebSocketRequestResponsePair ??= class {
	constructor(_a: string, _b: string) {}
};

// ────────────────────────────────────────────────────────────────────────────
// HELPERS
// ────────────────────────────────────────────────────────────────────────────

// biome-ignore lint/suspicious/noExplicitAny: Room exposes typed CF surfaces
// (DurableObject, WebSocket) we are stubbing; cast to keep tests pragmatic.
export type RoomLike = any;

export async function makeRoom(): Promise<{ room: RoomLike; ctx: StubCtx }> {
	// Dynamic import so the cloudflare:workers mock is in place.
	const { Room } = await import('./durable-object.js');
	const ctx = makeCtx();
	// biome-ignore lint/suspicious/noExplicitAny: env unused in our scenarios
	const room = new Room(ctx as any, {} as any) as RoomLike;
	// blockConcurrencyWhile is fire-and-forget in real CF; await readiness here.
	await Promise.resolve();
	return { room, ctx };
}

export function upgradeRequest(nodeId: string, userId = 'user-test'): Request {
	return new Request(`https://relay.test/?userId=${userId}&nodeId=${nodeId}`, {
		method: 'GET',
		headers: {
			Upgrade: 'websocket',
			'sec-websocket-protocol': 'epicenter',
		},
	});
}

/** Drive an upgrade end-to-end and return the server-side socket. */
export async function upgrade(
	room: RoomLike,
	nodeId: string,
	userId = 'user-test',
): Promise<StubWebSocket> {
	const response = await room.fetch(upgradeRequest(nodeId, userId));
	expect(response.status).toBe(101);
	// In real CF the response carries the CLIENT socket on `response.webSocket`;
	// Bun's `Response` ignores the field but the server socket is the
	// most-recently `acceptWebSocket`'d one.
	const ctx = room.ctx as StubCtx;
	const serverSocket = ctx.acceptedSockets[ctx.acceptedSockets.length - 1]!;
	return serverSocket;
}

export type WirePeer = {
	nodeId: string;
	connectedAt: number;
	actions: Record<string, unknown>;
	agentId?: string;
};
export type PresenceFrame = { type: 'presence'; peers: WirePeer[] };

/** Parse text frames of a given `type` off the wire. */
export function jsonFrames(
	ws: StubWebSocket,
	type: string,
): Array<Record<string, unknown>> {
	return ws
		.textFrames()
		.map((t) => {
			try {
				return JSON.parse(t) as Record<string, unknown>;
			} catch {
				return null;
			}
		})
		.filter((f): f is Record<string, unknown> => f !== null && f.type === type);
}

/** Parse all `presence` text frames out of the wire. */
export function presenceFrames(ws: StubWebSocket): PresenceFrame[] {
	return jsonFrames(ws, 'presence').filter((p): p is PresenceFrame =>
		Array.isArray((p as { peers?: unknown }).peers),
	);
}

/** Project a presence frame down to just its nodeIds, for assertions
 *  that don't care about connectedAt timestamps or action manifests. */
export function nodeIds(frame: PresenceFrame): string[] {
	return frame.peers.map((d) => d.nodeId);
}

/** Wrap a frame as the `ArrayBuffer` `webSocketMessage` expects for binary input. */
export function toArrayBuffer(frame: Uint8Array): ArrayBuffer {
	return frame.slice().buffer;
}

/** A well-formed binary sync frame: sync sub-type varint + payload. */
export function frameWithSyncType(
	syncType: number,
	payload: Uint8Array = new Uint8Array(0),
): Uint8Array {
	return encoding.encode((enc) => {
		encoding.writeVarUint(enc, syncType);
		encoding.writeVarUint8Array(enc, payload);
	});
}
