/// <reference lib="dom" />

/**
 * attachSync — SYNC_STATUS `hasLocalChanges` round-trip.
 *
 * The meaningful SYNC_STATUS behavior is narrow: every local doc update
 * bumps `localVersion`, a debounced probe sends the counter to the server,
 * the server echoes it back, and the echo drives `hasLocalChanges` toward
 * `false`. This test drives that loop with a minimal in-process WebSocket
 * stub — enough to observe the probe on the wire and inject the ack.
 */

import { beforeEach, describe, expect, test } from 'bun:test';
import {
	decodeRpcPayload,
	encodeRpcRequest,
	encodeRpcResponse,
	encodeSyncStatus,
	encodeSyncStep2,
	isRpcError,
	MESSAGE_TYPE,
	RpcError,
} from '@epicenter/sync';
import * as decoding from 'lib0/decoding';
import { Err, Ok } from 'wellcrafted/result';
import * as Y from 'yjs';
import Type from 'typebox';
import { defineMutation } from '../shared/actions.js';
import { attachSync } from './attach-sync.js';

// ── Minimal WebSocket stub ───────────────────────────────────────────────

type Listener = (ev: { data: ArrayBuffer | string }) => void;

class FakeWebSocket {
	static CONNECTING = 0;
	static OPEN = 1;
	static CLOSING = 2;
	static CLOSED = 3;

	static instances: FakeWebSocket[] = [];

	readyState = FakeWebSocket.CONNECTING;
	binaryType: 'arraybuffer' | 'blob' = 'blob';
	onopen: (() => void) | null = null;
	onclose: ((ev: { code: number; reason: string }) => void) | null = null;
	onerror: (() => void) | null = null;
	onmessage: Listener | null = null;

	readonly sent: Uint8Array[] = [];
	readonly protocols: string[];

	constructor(public readonly url: string, protocols?: string | string[]) {
		this.protocols = Array.isArray(protocols)
			? protocols
			: protocols
				? [protocols]
				: [];
		FakeWebSocket.instances.push(this);
		// Synthesize `open` on a microtask so attachSync's handlers are wired.
		queueMicrotask(() => {
			this.readyState = FakeWebSocket.OPEN;
			this.onopen?.();
		});
	}

	send(data: Uint8Array | string) {
		if (typeof data === 'string') return;
		this.sent.push(data instanceof Uint8Array ? data : new Uint8Array(data));
	}

	close(code?: number, reason?: string) {
		if (
			this.readyState === FakeWebSocket.CLOSED ||
			this.readyState === FakeWebSocket.CLOSING
		)
			return;
		this.readyState = FakeWebSocket.CLOSED;
		// 1005 = "no status received" — the spec value when JS calls close()
		// with no code, matching real browser behavior.
		this.onclose?.({ code: code ?? 1005, reason: reason ?? '' });
	}

	addEventListener() {}
	removeEventListener() {}

	/** Deliver a binary frame to the client. */
	deliver(frame: Uint8Array) {
		this.onmessage?.({
			data: frame.buffer.slice(
				frame.byteOffset,
				frame.byteOffset + frame.byteLength,
			) as ArrayBuffer,
		});
	}
}

const realWebSocket = globalThis.WebSocket;

beforeEach(() => {
	FakeWebSocket.instances = [];
	(globalThis as { WebSocket: unknown }).WebSocket = FakeWebSocket;
	return () => {
		(globalThis as { WebSocket: unknown }).WebSocket = realWebSocket;
	};
});

// ── Helpers ──────────────────────────────────────────────────────────────

/** Decode a message's top-level type without consuming the rest. */
function peekMessageType(frame: Uint8Array): number {
	return decoding.readVarUint(decoding.createDecoder(frame));
}

/** Build a server-sent STEP2 frame for the (empty) remote doc. */
function serverStep2Frame(): Uint8Array {
	const remote = new Y.Doc();
	const frame = encodeSyncStep2({ doc: remote });
	remote.destroy();
	return frame;
}

async function waitFor<T>(predicate: () => T | undefined, timeoutMs = 1000) {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		const value = predicate();
		if (value !== undefined && value !== false) return value;
		await new Promise((r) => setTimeout(r, 5));
	}
	throw new Error('timeout waiting for predicate');
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('attachSync hasLocalChanges', () => {
	test('connected status exposes hasLocalChanges: false after clean handshake', async () => {
		const ydoc = new Y.Doc({ guid: 'test-doc-1' });
		const sync = attachSync(ydoc, { url: `ws://x/${ydoc.guid}` });

		const ws = await waitFor(() => FakeWebSocket.instances[0]);
		await waitFor(() => ws.readyState === FakeWebSocket.OPEN);
		ws.deliver(serverStep2Frame());
		await sync.whenConnected;

		expect(sync.status).toEqual({
			phase: 'connected',
			hasLocalChanges: false,
		});

		ydoc.destroy();
		await sync.whenDisposed;
	});

	test('local update sends debounced SYNC_STATUS probe; echo flips hasLocalChanges back to false', async () => {
		const ydoc = new Y.Doc({ guid: 'test-doc-2' });
		const sync = attachSync(ydoc, { url: `ws://x/${ydoc.guid}` });

		const ws = await waitFor(() => FakeWebSocket.instances[0]);
		await waitFor(() => ws.readyState === FakeWebSocket.OPEN);
		ws.deliver(serverStep2Frame());
		await sync.whenConnected;

		const seenBefore = ws.sent.length;
		const statuses: unknown[] = [];
		const unsubscribe = sync.onStatusChange((s) => statuses.push(s));

		// Local update → localVersion increments; SYNC_STATUS goes out after 100ms.
		ydoc.getMap('m').set('k', 'v');

		const probe = await waitFor<Uint8Array>(() => {
			for (let i = seenBefore; i < ws.sent.length; i++) {
				const frame = ws.sent[i]!;
				if (peekMessageType(frame) === MESSAGE_TYPE.SYNC_STATUS) return frame;
			}
			return undefined;
		}, 500);

		// The probe payload is [100, localVersion].
		const dec = decoding.createDecoder(probe);
		expect(decoding.readVarUint(dec)).toBe(MESSAGE_TYPE.SYNC_STATUS);
		const probedVersion = decoding.readVarUint(dec);
		expect(probedVersion).toBeGreaterThan(0);

		// Server echoes the probe back unchanged → ackedVersion catches up,
		// the connected-variant emits hasLocalChanges=false.
		ws.deliver(encodeSyncStatus(probedVersion));

		await waitFor(() => statuses.length > 0);
		expect(sync.status).toEqual({
			phase: 'connected',
			hasLocalChanges: false,
		});

		unsubscribe();
		ydoc.destroy();
		await sync.whenDisposed;
	});

	test('getToken returning null blocks the first connect; reconnect after token becomes available proceeds with bearer subprotocol', async () => {
		const ydoc = new Y.Doc({ guid: 'test-token-gate' });
		let token: string | null = null;
		const sync = attachSync(ydoc, {
			url: `ws://x/${ydoc.guid}`,
			getToken: async () => token,
		});

		await waitFor(
			() =>
				sync.status.phase === 'connecting' &&
				sync.status.lastError?.type === 'auth',
		);
		expect(FakeWebSocket.instances.length).toBe(0);

		token = 'abc123';
		sync.reconnect();

		const ws = await waitFor(() => FakeWebSocket.instances[0]);
		expect(ws.protocols).toContain('bearer.abc123');

		await waitFor(() => ws.readyState === FakeWebSocket.OPEN);
		ws.deliver(serverStep2Frame());
		await sync.whenConnected;

		ydoc.destroy();
		await sync.whenDisposed;
	});

	test('updating the token source mid-session does not close the open socket; takes effect on reconnect', async () => {
		const ydoc = new Y.Doc({ guid: 'test-token-live' });
		let token: string | null = 'first';
		const sync = attachSync(ydoc, {
			url: `ws://x/${ydoc.guid}`,
			getToken: async () => token,
		});

		const ws = await waitFor(() => FakeWebSocket.instances[0]);
		expect(ws.protocols).toContain('bearer.first');
		await waitFor(() => ws.readyState === FakeWebSocket.OPEN);
		ws.deliver(serverStep2Frame());
		await sync.whenConnected;

		token = 'second';
		expect(ws.readyState).toBe(FakeWebSocket.OPEN);
		expect(FakeWebSocket.instances.length).toBe(1);

		ydoc.destroy();
		await sync.whenDisposed;
	});

	test('goOffline() closes the socket, prevents reconnect, and reconnect() re-opens', async () => {
		const ydoc = new Y.Doc({ guid: 'test-offline' });
		const sync = attachSync(ydoc, { url: `ws://x/${ydoc.guid}` });

		const ws = await waitFor(() => FakeWebSocket.instances[0]);
		await waitFor(() => ws.readyState === FakeWebSocket.OPEN);
		ws.deliver(serverStep2Frame());
		await sync.whenConnected;

		sync.goOffline();
		expect(sync.status).toEqual({ phase: 'offline' });
		expect(ws.readyState).toBe(FakeWebSocket.CLOSED);

		// Give the supervisor a beat to confirm it's NOT re-opening on its own.
		await new Promise((r) => setTimeout(r, 50));
		expect(FakeWebSocket.instances.length).toBe(1);

		sync.reconnect();
		const ws2 = await waitFor(() => FakeWebSocket.instances[1]);
		await waitFor(() => ws2.readyState === FakeWebSocket.OPEN);
		ws2.deliver(serverStep2Frame());
		await waitFor(() => sync.status.phase === 'connected');

		ydoc.destroy();
		await sync.whenDisposed;
	});

	test('inbound RPC request without dispatch config responds with ActionNotFound', async () => {
		const ydoc = new Y.Doc({ guid: 'test-rpc-no-dispatch' });
		const sync = attachSync(ydoc, { url: `ws://x/${ydoc.guid}` });

		const ws = await waitFor(() => FakeWebSocket.instances[0]);
		await waitFor(() => ws.readyState === FakeWebSocket.OPEN);
		ws.deliver(serverStep2Frame());
		await sync.whenConnected;

		const seenBefore = ws.sent.length;
		ws.deliver(
			encodeRpcRequest({
				requestId: 42,
				targetClientId: ydoc.clientID,
				requesterClientId: 9999,
				action: 'nothing.here',
				input: null,
			}),
		);

		const response = await waitFor<Uint8Array>(() => {
			for (let i = seenBefore; i < ws.sent.length; i++) {
				const frame = ws.sent[i]!;
				if (peekMessageType(frame) === MESSAGE_TYPE.RPC) return frame;
			}
			return undefined;
		}, 500);

		const dec = decoding.createDecoder(response);
		decoding.readVarUint(dec); // MESSAGE_TYPE.RPC
		const parsed = decodeRpcPayload(dec);
		expect(parsed.type).toBe('response');
		if (parsed.type !== 'response') throw new Error('unreachable');
		expect(parsed.requestId).toBe(42);
		expect(parsed.result.data).toBeNull();
		expect(isRpcError(parsed.result.error)).toBe(true);
		expect((parsed.result.error as { name: string }).name).toBe(
			'ActionNotFound',
		);

		ydoc.destroy();
		await sync.whenDisposed;
	});

	test('inbound RPC request with actions config forwards to handler and Ok-wraps raw return value', async () => {
		const ydoc = new Y.Doc({ guid: 'test-rpc-dispatch' });
		const calls: Array<{ action: string; input: unknown }> = [];
		const sync = attachSync(ydoc, {
			url: `ws://x/${ydoc.guid}`,
			actions: {
				tabs: {
					// Return a raw value — attachSync's handler is responsible for
					// normalizing it into a `{data, error}` envelope on the wire.
					close: defineMutation({
						input: Type.Object({ tabIds: Type.Array(Type.Number()) }),
						handler: (input) => {
							calls.push({ action: 'tabs.close', input });
							return { echo: input, action: 'tabs.close' };
						},
					}),
				},
			},
		});

		const ws = await waitFor(() => FakeWebSocket.instances[0]);
		await waitFor(() => ws.readyState === FakeWebSocket.OPEN);
		ws.deliver(serverStep2Frame());
		await sync.whenConnected;

		const seenBefore = ws.sent.length;
		ws.deliver(
			encodeRpcRequest({
				requestId: 7,
				targetClientId: ydoc.clientID,
				requesterClientId: 9999,
				action: 'tabs.close',
				input: { tabIds: [1, 2] },
			}),
		);

		const response = await waitFor<Uint8Array>(() => {
			for (let i = seenBefore; i < ws.sent.length; i++) {
				const frame = ws.sent[i]!;
				if (peekMessageType(frame) === MESSAGE_TYPE.RPC) return frame;
			}
			return undefined;
		}, 500);

		expect(calls).toEqual([
			{ action: 'tabs.close', input: { tabIds: [1, 2] } },
		]);

		const dec = decoding.createDecoder(response);
		decoding.readVarUint(dec);
		const parsed = decodeRpcPayload(dec);
		expect(parsed.type).toBe('response');
		if (parsed.type !== 'response') throw new Error('unreachable');
		expect(parsed.requestId).toBe(7);
		expect(parsed.result).toEqual(
			Ok({ echo: { tabIds: [1, 2] }, action: 'tabs.close' }),
		);

		ydoc.destroy();
		await sync.whenDisposed;
	});

	test('inbound RPC with action returning a Result passes the envelope through untouched', async () => {
		const ydoc = new Y.Doc({ guid: 'test-rpc-result-passthrough' });
		const sync = attachSync(ydoc, {
			url: `ws://x/${ydoc.guid}`,
			actions: {
				tabs: {
					// Handler returns an Err directly; attachSync must not re-wrap it.
					close: defineMutation({
						handler: () =>
							Err({ name: 'BrowserApiFailed', message: 'no tab 999' }),
					}),
				},
			},
		});

		const ws = await waitFor(() => FakeWebSocket.instances[0]);
		await waitFor(() => ws.readyState === FakeWebSocket.OPEN);
		ws.deliver(serverStep2Frame());
		await sync.whenConnected;

		const seenBefore = ws.sent.length;
		ws.deliver(
			encodeRpcRequest({
				requestId: 11,
				targetClientId: ydoc.clientID,
				requesterClientId: 9999,
				action: 'tabs.close',
				input: { tabIds: [999] },
			}),
		);

		const response = await waitFor<Uint8Array>(() => {
			for (let i = seenBefore; i < ws.sent.length; i++) {
				const frame = ws.sent[i]!;
				if (peekMessageType(frame) === MESSAGE_TYPE.RPC) return frame;
			}
			return undefined;
		}, 500);

		const dec = decoding.createDecoder(response);
		decoding.readVarUint(dec);
		const parsed = decodeRpcPayload(dec);
		expect(parsed.type).toBe('response');
		if (parsed.type !== 'response') throw new Error('unreachable');
		// The typed error survives on the wire — the handler's own Err shape
		// reaches the remote caller, not a wrapped RpcError.
		expect(parsed.result.data).toBeNull();
		expect(parsed.result.error).toEqual({
			name: 'BrowserApiFailed',
			message: 'no tab 999',
		});

		ydoc.destroy();
		await sync.whenDisposed;
	});

	test('inbound RPC with action that throws responds with RpcError.ActionFailed carrying the cause', async () => {
		const ydoc = new Y.Doc({ guid: 'test-rpc-throw' });
		const sync = attachSync(ydoc, {
			url: `ws://x/${ydoc.guid}`,
			actions: {
				tabs: {
					close: defineMutation({
						handler: () => {
							throw new Error('handler exploded');
						},
					}),
				},
			},
		});

		const ws = await waitFor(() => FakeWebSocket.instances[0]);
		await waitFor(() => ws.readyState === FakeWebSocket.OPEN);
		ws.deliver(serverStep2Frame());
		await sync.whenConnected;

		const seenBefore = ws.sent.length;
		ws.deliver(
			encodeRpcRequest({
				requestId: 12,
				targetClientId: ydoc.clientID,
				requesterClientId: 9999,
				action: 'tabs.close',
				input: null,
			}),
		);

		const response = await waitFor<Uint8Array>(() => {
			for (let i = seenBefore; i < ws.sent.length; i++) {
				const frame = ws.sent[i]!;
				if (peekMessageType(frame) === MESSAGE_TYPE.RPC) return frame;
			}
			return undefined;
		}, 500);

		const dec = decoding.createDecoder(response);
		decoding.readVarUint(dec);
		const parsed = decodeRpcPayload(dec);
		expect(parsed.type).toBe('response');
		if (parsed.type !== 'response') throw new Error('unreachable');
		expect(parsed.result.data).toBeNull();
		expect(isRpcError(parsed.result.error)).toBe(true);
		const err = parsed.result.error as { name: string; action: string };
		expect(err.name).toBe('ActionFailed');
		expect(err.action).toBe('tabs.close');

		ydoc.destroy();
		await sync.whenDisposed;
	});

	// ── Outbound rpc() — caller-side response handling ────────────────────
	//
	// These tests drive the client half of the wire: call `sync.rpc()`,
	// pluck the emitted request frame to learn the requestId, then inject
	// a response frame with various payloads and verify the pending-promise
	// resolver at attach-sync.ts:812-832 routes to the right branch.

	test('outbound rpc() resolves with Ok when response carries {data, error:null}', async () => {
		const ydoc = new Y.Doc({ guid: 'outbound-ok' });
		const sync = attachSync(ydoc, { url: `ws://x/${ydoc.guid}` });

		const ws = await waitFor(() => FakeWebSocket.instances[0]);
		await waitFor(() => ws.readyState === FakeWebSocket.OPEN);
		ws.deliver(serverStep2Frame());
		await sync.whenConnected;

		const seenBefore = ws.sent.length;
		const rpcPromise = sync.rpc(12345, 'tabs.close', { tabIds: [1] });

		// Capture the outgoing request frame to learn its requestId.
		const requestFrame = await waitFor<Uint8Array>(() => {
			for (let i = seenBefore; i < ws.sent.length; i++) {
				const frame = ws.sent[i]!;
				if (peekMessageType(frame) === MESSAGE_TYPE.RPC) return frame;
			}
			return undefined;
		});
		const dec = decoding.createDecoder(requestFrame);
		decoding.readVarUint(dec);
		const parsed = decodeRpcPayload(dec);
		if (parsed.type !== 'request') throw new Error('expected request');

		ws.deliver(
			encodeRpcResponse({
				requestId: parsed.requestId,
				requesterClientId: ydoc.clientID,
				result: Ok({ closedCount: 1 }),
			}),
		);

		const result = await rpcPromise;
		expect(result.data).toEqual({ closedCount: 1 });
		expect(result.error).toBeNull();

		ydoc.destroy();
		await sync.whenDisposed;
	});

	test('outbound rpc() passes an RpcError response through unchanged', async () => {
		const ydoc = new Y.Doc({ guid: 'outbound-rpcerror' });
		const sync = attachSync(ydoc, { url: `ws://x/${ydoc.guid}` });

		const ws = await waitFor(() => FakeWebSocket.instances[0]);
		await waitFor(() => ws.readyState === FakeWebSocket.OPEN);
		ws.deliver(serverStep2Frame());
		await sync.whenConnected;

		const seenBefore = ws.sent.length;
		const rpcPromise = sync.rpc(12345, 'tabs.close', { tabIds: [1] });

		const requestFrame = await waitFor<Uint8Array>(() => {
			for (let i = seenBefore; i < ws.sent.length; i++) {
				const frame = ws.sent[i]!;
				if (peekMessageType(frame) === MESSAGE_TYPE.RPC) return frame;
			}
			return undefined;
		});
		const dec = decoding.createDecoder(requestFrame);
		decoding.readVarUint(dec);
		const parsed = decodeRpcPayload(dec);
		if (parsed.type !== 'request') throw new Error('expected request');

		// Remote side emitted a recognizable RpcError — the outbound handler
		// must recognize it via isRpcError and pass it through, not re-wrap.
		ws.deliver(
			encodeRpcResponse({
				requestId: parsed.requestId,
				requesterClientId: ydoc.clientID,
				result: RpcError.ActionFailed({
					action: 'tabs.close',
					cause: 'kaboom',
				}),
			}),
		);

		const result = await rpcPromise;
		expect(result.data).toBeNull();
		expect(isRpcError(result.error)).toBe(true);
		expect((result.error as RpcError).name).toBe('ActionFailed');
	});

	test('outbound rpc() wraps an unknown (non-RpcError) error as RpcError.ActionFailed', async () => {
		// This is the "type erasure" path: a peer returns a typed Err that
		// isn't an RpcError variant. The client-side handler re-wraps it as
		// ActionFailed with the original error as `cause`. This is a property
		// of the legacy sync.rpc() API — createRemoteActions preserves E.
		const ydoc = new Y.Doc({ guid: 'outbound-wrap' });
		const sync = attachSync(ydoc, { url: `ws://x/${ydoc.guid}` });

		const ws = await waitFor(() => FakeWebSocket.instances[0]);
		await waitFor(() => ws.readyState === FakeWebSocket.OPEN);
		ws.deliver(serverStep2Frame());
		await sync.whenConnected;

		const seenBefore = ws.sent.length;
		const rpcPromise = sync.rpc(12345, 'tabs.close', { tabIds: [1] });

		const requestFrame = await waitFor<Uint8Array>(() => {
			for (let i = seenBefore; i < ws.sent.length; i++) {
				const frame = ws.sent[i]!;
				if (peekMessageType(frame) === MESSAGE_TYPE.RPC) return frame;
			}
			return undefined;
		});
		const dec = decoding.createDecoder(requestFrame);
		decoding.readVarUint(dec);
		const parsed = decodeRpcPayload(dec);
		if (parsed.type !== 'request') throw new Error('expected request');

		const typedErr = {
			name: 'BrowserApiFailed',
			message: 'no tab 999',
		};
		ws.deliver(
			encodeRpcResponse({
				requestId: parsed.requestId,
				requesterClientId: ydoc.clientID,
				result: Err(typedErr),
			}),
		);

		const result = await rpcPromise;
		expect(result.data).toBeNull();
		const err = result.error as RpcError;
		expect(err.name).toBe('ActionFailed');
		if (err.name !== 'ActionFailed') throw new Error('unreachable');
		expect(err.action).toBe('tabs.close');
		// The typed error survives as `cause`, one layer deep.
		expect(err.cause).toEqual(typedErr);
	});

	// ── End-to-end loopback — proves the full wire protocol works ─────────
	//
	// Two attachSync peers, their FakeWebSockets cross-wired so a frame sent
	// by one gets delivered to the other's `onmessage`. This simulates the
	// broker routing RPC frames between clients. A real `sync.rpc()` call
	// from Alice travels through her socket → Bob's socket → Bob's inbound
	// dispatch handler → back through Bob's socket → Alice's socket → Alice's
	// pending-request resolver.
	//
	// This is the test that says "RPC actually works end-to-end."

	test('end-to-end RPC: Alice calls Bob, Bob handles, Alice gets the response', async () => {
		const aliceDoc = new Y.Doc({ guid: 'e2e-alice' });
		const bobDoc = new Y.Doc({ guid: 'e2e-bob' });

		const bobDispatchCalls: Array<{ action: string; input: unknown }> = [];
		const aliceSync = attachSync(aliceDoc, { url: 'ws://alice' });
		const bobSync = attachSync(bobDoc, {
			url: 'ws://bob',
			actions: {
				tabs: {
					close: defineMutation({
						input: Type.Object({ tabIds: Type.Array(Type.Number()) }),
						handler: (input) => {
							bobDispatchCalls.push({ action: 'tabs.close', input });
							return { closedCount: input.tabIds.length };
						},
					}),
				},
			},
		});

		const aliceWs = await waitFor(() => FakeWebSocket.instances[0]);
		const bobWs = await waitFor(() => FakeWebSocket.instances[1]);
		await waitFor(() => aliceWs.readyState === FakeWebSocket.OPEN);
		await waitFor(() => bobWs.readyState === FakeWebSocket.OPEN);
		aliceWs.deliver(serverStep2Frame());
		bobWs.deliver(serverStep2Frame());
		await aliceSync.whenConnected;
		await bobSync.whenConnected;

		// Fire the RPC — Alice doesn't know where her frames "go" from the
		// FakeWebSocket's perspective, so the test plays broker by polling
		// her sent queue and redelivering to Bob.
		const aliceSentBefore = aliceWs.sent.length;
		const rpcPromise = aliceSync.rpc(bobDoc.clientID, 'tabs.close', {
			tabIds: [1, 2, 3],
		});

		const requestFrame = await waitFor<Uint8Array>(() => {
			for (let i = aliceSentBefore; i < aliceWs.sent.length; i++) {
				const frame = aliceWs.sent[i]!;
				if (peekMessageType(frame) === MESSAGE_TYPE.RPC) return frame;
			}
			return undefined;
		});

		// Route request → Bob (broker simulation).
		const bobSentBefore = bobWs.sent.length;
		bobWs.deliver(requestFrame);

		// Wait for Bob's response to appear on his send queue, then route back.
		const responseFrame = await waitFor<Uint8Array>(() => {
			for (let i = bobSentBefore; i < bobWs.sent.length; i++) {
				const frame = bobWs.sent[i]!;
				if (peekMessageType(frame) === MESSAGE_TYPE.RPC) return frame;
			}
			return undefined;
		});
		aliceWs.deliver(responseFrame);

		const result = await rpcPromise;

		expect(result.error).toBeNull();
		expect(result.data).toEqual({ closedCount: 3 });
		expect(bobDispatchCalls).toEqual([
			{ action: 'tabs.close', input: { tabIds: [1, 2, 3] } },
		]);

		aliceDoc.destroy();
		bobDoc.destroy();
		await aliceSync.whenDisposed;
		await bobSync.whenDisposed;
	});

	test('fresh connection resets version counters — prior unacked writes do not leak state', async () => {
		const ydoc = new Y.Doc({ guid: 'test-doc-3' });
		const sync = attachSync(ydoc, { url: `ws://x/${ydoc.guid}` });

		const firstWs = await waitFor(() => FakeWebSocket.instances[0]);
		await waitFor(() => firstWs.readyState === FakeWebSocket.OPEN);
		firstWs.deliver(serverStep2Frame());
		await sync.whenConnected;

		// Mutate without letting the probe echo back; drop the connection.
		ydoc.getMap('m').set('k', 'v');
		firstWs.close();

		const secondWs = await waitFor(
			() => FakeWebSocket.instances[1],
			3000,
		);
		await waitFor(() => secondWs.readyState === FakeWebSocket.OPEN);
		secondWs.deliver(serverStep2Frame());

		await waitFor(
			() =>
				sync.status.phase === 'connected' && !sync.status.hasLocalChanges,
		);

		ydoc.destroy();
		await sync.whenDisposed;
	});
});

// ── Failed phase (server close 4401) ────────────────────────────────────

describe('attachSync failed phase', () => {
	test('server close 4401 with valid JSON reason transitions to phase: failed with parsed code', async () => {
		const ydoc = new Y.Doc({ guid: 'failed-valid-json' });
		const sync = attachSync(ydoc, { url: `ws://x/${ydoc.guid}` });

		const ws = await waitFor(() => FakeWebSocket.instances[0]);
		await waitFor(() => ws.readyState === FakeWebSocket.OPEN);

		ws.close(4401, JSON.stringify({ code: 'invalid_token' }));

		await waitFor(() => sync.status.phase === 'failed');
		expect(sync.status).toEqual({
			phase: 'failed',
			reason: { type: 'auth', code: 'invalid_token' },
		});

		ydoc.destroy();
		await sync.whenDisposed;
	});

	test('whenConnected rejects with SyncFailedError when entering failed', async () => {
		const ydoc = new Y.Doc({ guid: 'failed-rejects-when-connected' });
		const sync = attachSync(ydoc, { url: `ws://x/${ydoc.guid}` });

		const ws = await waitFor(() => FakeWebSocket.instances[0]);
		await waitFor(() => ws.readyState === FakeWebSocket.OPEN);

		ws.close(4401, JSON.stringify({ code: 'token_expired' }));

		let caught: unknown;
		try {
			await sync.whenConnected;
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeDefined();
		const err = caught as { name: string; code: string };
		expect(err.name).toBe('AuthRejected');
		expect(err.code).toBe('token_expired');

		ydoc.destroy();
		await sync.whenDisposed;
	});

	test('malformed JSON reason falls back to code: unknown', async () => {
		const ydoc = new Y.Doc({ guid: 'failed-malformed' });
		const sync = attachSync(ydoc, { url: `ws://x/${ydoc.guid}` });

		const ws = await waitFor(() => FakeWebSocket.instances[0]);
		await waitFor(() => ws.readyState === FakeWebSocket.OPEN);

		ws.close(4401, 'not json');

		await waitFor(() => sync.status.phase === 'failed');
		expect(sync.status).toEqual({
			phase: 'failed',
			reason: { type: 'auth', code: 'unknown' },
		});

		ydoc.destroy();
		await sync.whenDisposed;
	});

	test('empty reason on 4401 falls back to code: unknown', async () => {
		const ydoc = new Y.Doc({ guid: 'failed-empty-reason' });
		const sync = attachSync(ydoc, { url: `ws://x/${ydoc.guid}` });

		const ws = await waitFor(() => FakeWebSocket.instances[0]);
		await waitFor(() => ws.readyState === FakeWebSocket.OPEN);

		ws.close(4401, '');

		await waitFor(() => sync.status.phase === 'failed');
		expect(sync.status).toEqual({
			phase: 'failed',
			reason: { type: 'auth', code: 'unknown' },
		});

		ydoc.destroy();
		await sync.whenDisposed;
	});

	test('reconnect() clears failed state and the supervisor opens a new socket', async () => {
		const ydoc = new Y.Doc({ guid: 'failed-then-reconnect' });
		const sync = attachSync(ydoc, { url: `ws://x/${ydoc.guid}` });

		const ws = await waitFor(() => FakeWebSocket.instances[0]);
		await waitFor(() => ws.readyState === FakeWebSocket.OPEN);

		ws.close(4401, JSON.stringify({ code: 'invalid_token' }));
		await waitFor(() => sync.status.phase === 'failed');

		sync.reconnect();

		const ws2 = await waitFor(() => FakeWebSocket.instances[1]);
		expect(ws2).toBeDefined();
		await waitFor(() => sync.status.phase !== 'failed');

		ydoc.destroy();
		await sync.whenDisposed;
	});

	test('non-4401 close codes still trigger retry (no regression)', async () => {
		const ydoc = new Y.Doc({ guid: 'failed-non-4401-retries' });
		const sync = attachSync(ydoc, { url: `ws://x/${ydoc.guid}` });

		const ws = await waitFor(() => FakeWebSocket.instances[0]);
		await waitFor(() => ws.readyState === FakeWebSocket.OPEN);

		ws.close(1006, '');

		const ws2 = await waitFor(() => FakeWebSocket.instances[1], 3000);
		expect(ws2).toBeDefined();
		// Status should reach 'connecting' again, never 'failed'.
		expect(sync.status.phase).not.toBe('failed');
		await waitFor(
			() =>
				sync.status.phase === 'connecting' ||
				sync.status.phase === 'connected',
		);

		ydoc.destroy();
		await sync.whenDisposed;
	});
});

// ── Presence (device + standard awareness) ──────────────────────────────

describe('attachSync presence', () => {
	test('device publishes synchronously as a presence-only descriptor', () => {
		const ydoc = new Y.Doc({ guid: 'presence-1' });
		const actions = {
			tabs: {
				close: defineMutation({
					input: Type.Object({ tabIds: Type.Array(Type.Number()) }),
					handler: () => ({ closedCount: 0 }),
				}),
			},
		};

		const sync = attachSync(
			{ ydoc, actions },
			{
				url: `ws://x/${ydoc.guid}`,
				device: { id: 'mac-1', name: 'MacBook', platform: 'web' },
			},
		);

		const localState = sync.raw.awareness?.getLocalState() as {
			device: Record<string, unknown>;
		};
		expect(localState.device).toEqual({
			id: 'mac-1',
			name: 'MacBook',
			platform: 'web',
		});
		expect(localState.device).not.toHaveProperty('offers');

		ydoc.destroy();
	});

	test('peers() excludes self; find() resolves by deviceId', () => {
		const ydoc = new Y.Doc({ guid: 'presence-2' });
		const sync = attachSync(
			{ ydoc },
			{
				url: `ws://x/${ydoc.guid}`,
				device: { id: 'mac-1', name: 'MacBook', platform: 'web' },
			},
		);

		sync.raw.awareness!.getStates().set(202, {
			device: {
				id: 'iphone-15',
				name: 'Phone',
				platform: 'tauri',
			},
		});

		const peers = sync.peers();
		expect(peers.has(sync.raw.awareness!.clientID)).toBe(false);
		expect(peers.get(202)?.device.id).toBe('iphone-15');

		expect(sync.find('iphone-15')?.clientId).toBe(202);
		expect(sync.find('ghost')).toBeUndefined();

		ydoc.destroy();
	});

	test('peers/find/observe are no-ops when no device configured', () => {
		const ydoc = new Y.Doc({ guid: 'presence-3' });
		const sync = attachSync(ydoc, { url: `ws://x/${ydoc.guid}` });

		expect(sync.peers().size).toBe(0);
		expect(sync.find('anything')).toBeUndefined();
		const unsubscribe = sync.observe(() => {});
		expect(typeof unsubscribe).toBe('function');
		expect(sync.raw.awareness).toBeNull();

		ydoc.destroy();
	});

	test('rejects passing both device and external awareness', () => {
		const ydoc = new Y.Doc({ guid: 'presence-4' });
		expect(() =>
			attachSync(ydoc, {
				url: `ws://x/${ydoc.guid}`,
				device: { id: 'a', name: 'a', platform: 'web' },
				// biome-ignore lint/suspicious/noExplicitAny: testing the runtime guard
				awareness: {} as any,
			}),
		).toThrow(/either `device`.*or `awareness`/);
		ydoc.destroy();
	});

	test('serialized PeerDevice payload is under 200 bytes', () => {
		const ydoc = new Y.Doc({ guid: 'presence-size' });
		const sync = attachSync(ydoc, {
			url: `ws://x/${ydoc.guid}`,
			device: {
				id: 'mac-pro-m3-max-2024-braden',
				name: 'Braden MacBook Pro',
				platform: 'tauri',
			},
		});
		const local = sync.raw.awareness?.getLocalState();
		const bytes = JSON.stringify(local).length;
		expect(bytes).toBeLessThan(200);
		ydoc.destroy();
	});
});

