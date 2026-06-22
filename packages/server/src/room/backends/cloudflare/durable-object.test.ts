/**
 * `Room` Durable Object tests.
 *
 * Exercises the relay's two WebSocket wire surfaces through the live `Room`:
 *
 * Presence: the relay broadcasts one `presence` text frame carrying the
 * FULL peer list on every connection change. Covers the directed frame
 * on upgrade, the first-socket rebroadcast, multi-tab dedup (the list is
 * unchanged so no rebroadcast), the debounced rebroadcast on last-socket
 * close, graceful handoff cancellation, the 4401 grace bypass, and
 * broadcast resilience against wedged sockets.
 *
 * Binary sync: a y-protocols update from one socket fans out to peer
 * sockets but not its origin, and a malformed binary frame is logged
 * rather than thrown out of the message handler.
 *
 * Bun's test runtime does not provide Cloudflare Workers globals, so we
 * mock `cloudflare:workers` (DurableObject base class), shim
 * `WebSocketPair` / `WebSocket`, and drive the Room via its public
 * `fetch()` and `webSocketClose()` overrides directly.
 */

import { describe, expect, test } from 'bun:test';
import {
	encodeSyncStep1,
	encodeSyncUpdate,
	SYNC_MESSAGE_TYPE,
} from '@epicenter/sync';
import * as Y from 'yjs';
import {
	frameWithSyncType,
	jsonFrames,
	makeCtx,
	makeRoom,
	nodeIds,
	presenceFrames,
	type StubWebSocket,
	toArrayBuffer,
	upgrade,
} from './test-harness.js';

// ────────────────────────────────────────────────────────────────────────────
// TESTS
// ────────────────────────────────────────────────────────────────────────────

describe('Room presence: directed frame on upgrade', () => {
	test('first socket receives an empty node list', async () => {
		const { room } = await makeRoom();
		const ws = await upgrade(room, 'A');
		expect(presenceFrames(ws).map(nodeIds)).toEqual([[]]);
	});

	test('second node upgrade sees the first node in its directed frame', async () => {
		const { room } = await makeRoom();
		await upgrade(room, 'A');
		const ws = await upgrade(room, 'B');
		expect(presenceFrames(ws).map(nodeIds)).toEqual([['A']]);
	});

	test('directed frame to a new tab excludes the receiver own node', async () => {
		const { room } = await makeRoom();
		await upgrade(room, 'A');
		await upgrade(room, 'B');
		const ws = await upgrade(room, 'A'); // second A tab
		// The new tab's only frame is the directed one; it lists B, not A.
		expect(nodeIds(presenceFrames(ws)[0]!)).toEqual(['B']);
	});

	test('directed frame entries include connectedAt and an empty actions manifest by default', async () => {
		const { room } = await makeRoom();
		await upgrade(room, 'A');
		const ws = await upgrade(room, 'B');
		const [frame] = presenceFrames(ws);
		expect(frame).toBeDefined();
		const [nodeA] = frame!.peers;
		expect(nodeA).toBeDefined();
		expect(nodeA!.nodeId).toBe('A');
		expect(typeof nodeA!.connectedAt).toBe('number');
		expect(nodeA!.actions).toEqual({});
	});
});

describe('Room presence: agent designation', () => {
	test('a published agentId rides the peer entry to other nodes', async () => {
		const { room } = await makeRoom();
		const daemonWs = await upgrade(room, 'daemon');
		await room.webSocketMessage(
			daemonWs,
			JSON.stringify({
				type: 'presence_publish',
				actions: {},
				agentId: 'vocab-home',
			}),
		);
		// A node connecting after the publish sees the daemon's designation in its
		// directed snapshot: the join key a picker uses to light up that agent.
		const observer = await upgrade(room, 'observer');
		const daemon = presenceFrames(observer)[0]!.peers.find(
			(p) => p.nodeId === 'daemon',
		);
		expect(daemon!.agentId).toBe('vocab-home');
	});

	test('a peer that never publishes an agentId omits it', async () => {
		const { room } = await makeRoom();
		await upgrade(room, 'plain');
		const observer = await upgrade(room, 'observer');
		const plain = presenceFrames(observer)[0]!.peers.find(
			(p) => p.nodeId === 'plain',
		);
		expect(plain!.agentId).toBeUndefined();
	});
});

describe('Room presence: first-socket rebroadcast', () => {
	test('first socket for a node rebroadcasts the list to existing peers', async () => {
		const { room } = await makeRoom();
		const wsA = await upgrade(room, 'A');
		const before = presenceFrames(wsA).length;
		await upgrade(room, 'B');
		const after = presenceFrames(wsA).slice(before);
		expect(after.map(nodeIds)).toEqual([['B']]);
	});

	test('subsequent socket for the SAME node does NOT rebroadcast', async () => {
		const { room } = await makeRoom();
		const wsA = await upgrade(room, 'A');
		await upgrade(room, 'B'); // first B socket: rebroadcast to A
		const beforeSecondTab = presenceFrames(wsA).length;
		await upgrade(room, 'B'); // second B tab: list unchanged, no rebroadcast
		expect(presenceFrames(wsA).slice(beforeSecondTab)).toEqual([]);
	});
});

describe('Room presence: rebroadcast on close', () => {
	test('last socket close debounces a rebroadcast that fires after grace', async () => {
		const { room } = await makeRoom();
		const wsA = await upgrade(room, 'A');
		const wsB = await upgrade(room, 'B');
		const beforeClose = presenceFrames(wsA).length;
		await room.webSocketClose(wsB, 1000, 'bye', true);
		// Immediately after close: nothing yet (debounce armed).
		expect(presenceFrames(wsA).slice(beforeClose)).toEqual([]);

		await new Promise((r) => setTimeout(r, 350));
		expect(presenceFrames(wsA).slice(beforeClose).map(nodeIds)).toEqual([[]]);
	});

	test('intermediate socket close (multi-tab) emits NO rebroadcast', async () => {
		const { room } = await makeRoom();
		const wsA = await upgrade(room, 'A');
		const wsB1 = await upgrade(room, 'B');
		await upgrade(room, 'B'); // second B tab keeps the node alive
		const before = presenceFrames(wsA).length;
		await room.webSocketClose(wsB1, 1000, 'bye', true);
		await new Promise((r) => setTimeout(r, 350));
		expect(presenceFrames(wsA).slice(before)).toEqual([]);
	});
});

describe('Room presence: graceful handoff', () => {
	test('cancel-then-replace: T1 closes, T2 connects inside grace, T2 closes outside grace', async () => {
		const { room } = await makeRoom();
		const wsA = await upgrade(room, 'A');
		const wsB1 = await upgrade(room, 'B');
		const baseline = presenceFrames(wsA).length;

		await room.webSocketClose(wsB1, 1000, 'tab handoff', true);
		await new Promise((r) => setTimeout(r, 100));
		const wsB2 = await upgrade(room, 'B');
		// Past the original grace window from B1's close:
		await new Promise((r) => setTimeout(r, 350));

		// No "B gone" frame: the replacement cancelled the debounce.
		for (const frame of presenceFrames(wsA).slice(baseline)) {
			expect(nodeIds(frame)).toContain('B');
		}

		// Now close B2 with no replacement.
		const afterMid = presenceFrames(wsA).length;
		await room.webSocketClose(wsB2, 1000, 'gone', true);
		await new Promise((r) => setTimeout(r, 350));
		expect(presenceFrames(wsA).slice(afterMid).map(nodeIds)).toEqual([[]]);
	});
});

describe('Room presence: hibernation/wake', () => {
	test('connections survive a fresh DO construction with the same ctx', async () => {
		// Simulate hibernation by constructing a second `Room` that shares
		// `ctx.getWebSockets()`. The new Room must rebuild `connections`
		// from the surviving sockets without emitting spurious presence
		// transitions to them.
		const { Room } = await import('./durable-object.js');
		const ctx = makeCtx();
		// biome-ignore lint/suspicious/noExplicitAny: env unused
		const r1 = new Room(ctx as any, {} as any);
		await Promise.resolve();

		await upgrade(r1, 'A');
		await upgrade(r1, 'B');

		// Build a "woken" Room reusing the same accepted sockets.
		// biome-ignore lint/suspicious/noExplicitAny: env unused
		const r2 = new Room(ctx as any, {} as any);
		await Promise.resolve();

		// A new upgrade post-wake should see both A and B in its directed frame.
		const wsC = await upgrade(r2, 'C');
		expect(nodeIds(presenceFrames(wsC)[0]!)).toEqual(['A', 'B']);
	});
});

describe('Room presence: 4401 bypasses grace', () => {
	test('close code 4401 rebroadcasts immediately', async () => {
		const { room } = await makeRoom();
		const wsA = await upgrade(room, 'A');
		const wsB = await upgrade(room, 'B');
		const before = presenceFrames(wsA).length;

		await room.webSocketClose(wsB, 4401, 'auth expired', false);
		// No grace wait.
		expect(presenceFrames(wsA).slice(before).map(nodeIds)).toEqual([[]]);
	});

	test('close code 4401 cancels a pending debounced rebroadcast', async () => {
		const { room } = await makeRoom();
		const wsA = await upgrade(room, 'A');
		const wsB = await upgrade(room, 'B');
		const wsC = await upgrade(room, 'C');

		// B's close arms the debounced rebroadcast timer.
		await room.webSocketClose(wsB, 1000, 'bye', true);
		// C's 4401 close rebroadcasts immediately and must cancel B's pending
		// timer so A sees exactly one frame, not a later double-fire.
		const before = presenceFrames(wsA).length;
		await room.webSocketClose(wsC, 4401, 'auth expired', false);
		await new Promise((r) => setTimeout(r, 350));
		expect(presenceFrames(wsA).slice(before).map(nodeIds)).toEqual([[]]);
	});
});

describe('Room presence: broadcast resilience', () => {
	test('a wedged socket does not abort the rebroadcast loop', async () => {
		const { room } = await makeRoom();
		const wsA = await upgrade(room, 'A');
		const wsB = await upgrade(room, 'B');
		// Wedge A so future `send` calls throw.
		wsA.__wedge();

		// Trigger a rebroadcast by connecting a third node.
		const wsC = await upgrade(room, 'C');

		// A's wedged socket recorded nothing past wedging, but B must have
		// received a rebroadcast listing C.
		const bFrames = presenceFrames(wsB);
		expect(nodeIds(bFrames[bFrames.length - 1]!)).toContain('C');

		// C's own directed frame saw A and B (sent before any wedged send).
		expect(nodeIds(presenceFrames(wsC)[0]!)).toEqual(['A', 'B']);
	});
});

describe('Room sync: binary update fan-out', () => {
	test('STEP1 frames receive a STEP2 reply', async () => {
		const { room } = await makeRoom();
		const ws = await upgrade(room, 'A');
		const before = ws.sent.length;

		await room.webSocketMessage(
			ws,
			toArrayBuffer(encodeSyncStep1({ doc: new Y.Doc() })),
		);

		const replies = ws.sent
			.slice(before)
			.filter((frame): frame is Uint8Array => frame instanceof Uint8Array);
		expect(replies).toHaveLength(1);
		expect(replies[0]?.[0]).toBe(SYNC_MESSAGE_TYPE.STEP2);
	});

	test('an update from one socket reaches peers but not its origin', async () => {
		const { room } = await makeRoom();
		const wsA = await upgrade(room, 'A');
		const wsB = await upgrade(room, 'B');

		const beforeA = wsA.sent.length;
		const beforeB = wsB.sent.length;

		// wsA sends a sync UPDATE frame carrying fresh doc state.
		const source = new Y.Doc();
		source.getMap('data').set('hello', 'world');
		const frame = encodeSyncUpdate({
			update: Y.encodeStateAsUpdateV2(source),
		});
		await room.webSocketMessage(wsA, toArrayBuffer(frame));

		// The peer receives one new binary frame; the origin receives none.
		const newBinary = (ws: StubWebSocket, before: number) =>
			ws.sent.slice(before).filter((f) => f instanceof Uint8Array);
		expect(newBinary(wsB, beforeB).length).toBe(1);
		expect(newBinary(wsA, beforeA).length).toBe(0);
	});

	test('truncated frames are caught without throwing out of the handler', async () => {
		const { room } = await makeRoom();
		const ws = await upgrade(room, 'A');
		const before = ws.sent.length;
		const truncated = new Uint8Array([SYNC_MESSAGE_TYPE.UPDATE, 10]);

		await room.webSocketMessage(ws, toArrayBuffer(truncated));

		// Handler swallows the decode error: no response, no close.
		// (Whether it logs and via which logger is implementation detail.)
		expect(ws.sent.slice(before)).toEqual([]);
		expect(ws.closeCalls).toEqual([]);
	});

	test('decodable out-of-range sync sub-types are no-ops', async () => {
		const { room } = await makeRoom();
		const ws = await upgrade(room, 'A');
		const before = ws.sent.length;

		await room.webSocketMessage(ws, toArrayBuffer(frameWithSyncType(99)));

		expect(ws.sent.slice(before)).toEqual([]);
		expect(ws.closeCalls).toEqual([]);
	});
});

describe('Room connection lifetime', () => {
	test('a socket past the max lifetime is closed with the reconnect code and its frame is dropped', async () => {
		const { room } = await makeRoom();
		const ws = await upgrade(room, 'A');
		const before = ws.sent.length;
		// Age the connection past MAX_CONNECTION_LIFETIME_MS (30 min) by
		// rewriting connectedAt on the stored attachment.
		const attachment = ws.deserializeAttachment() as { connectedAt: number };
		ws.serializeAttachment({
			...attachment,
			connectedAt: Date.now() - 31 * 60_000,
		});

		await room.webSocketMessage(
			ws,
			toArrayBuffer(encodeSyncStep1({ doc: new Y.Doc() })),
		);

		// Closed with the transient reconnect code (not the permanent 4401),
		// and the STEP1 produced no STEP2 reply because the frame was dropped.
		expect(ws.closeCalls.map((c) => c.code)).toEqual([4408]);
		expect(ws.sent.slice(before)).toEqual([]);
	});

	test('a fresh socket is served normally and not closed', async () => {
		const { room } = await makeRoom();
		const ws = await upgrade(room, 'A');

		await room.webSocketMessage(
			ws,
			toArrayBuffer(encodeSyncStep1({ doc: new Y.Doc() })),
		);

		expect(ws.closeCalls).toEqual([]);
	});

	test('the alarm sweep closes an idle over-age socket with no inbound frame', async () => {
		const { room } = await makeRoom();
		const wsOld = await upgrade(room, 'A');
		const wsFresh = await upgrade(room, 'B');
		// Age wsOld past the lifetime; it never sends a frame (the idle case the
		// per-message check cannot catch).
		const attachment = wsOld.deserializeAttachment() as { connectedAt: number };
		wsOld.serializeAttachment({
			...attachment,
			connectedAt: Date.now() - 31 * 60_000,
		});

		await room.alarm();

		expect(wsOld.closeCalls.map((c) => c.code)).toEqual([4408]);
		expect(wsFresh.closeCalls).toEqual([]);
	});
});

describe('Room sync: HTTP sync RPC', () => {
	test('a malformed sync body resolves to Err(MalformedSyncBody)', async () => {
		const { room } = await makeRoom();
		// A length prefix claiming 10 payload bytes that are not present:
		// lib0 readVarUint8Array underflows inside decodeSyncRequest.
		const { error } = await room.sync(new Uint8Array([10]));

		expect(error?.name).toBe('MalformedSyncBody');
	});
});

// ────────────────────────────────────────────────────────────────────────────
// DISPATCH
// ────────────────────────────────────────────────────────────────────────────

describe('Room dispatch: relay round trip', () => {
	test('dispatch_request routes dispatch_inbound to the recipient', async () => {
		const { room } = await makeRoom();
		const callerWs = await upgrade(room, 'caller');
		const recipientWs = await upgrade(room, 'recipient');

		await room.webSocketMessage(
			callerWs,
			JSON.stringify({
				type: 'dispatch_request',
				id: 'd1',
				to: 'recipient',
				action: 'noop_ping',
				input: { x: 1 },
			}),
		);

		const inbound = jsonFrames(recipientWs, 'dispatch_inbound');
		expect(inbound).toHaveLength(1);
		expect(inbound[0]).toMatchObject({
			id: 'd1',
			action: 'noop_ping',
			input: { x: 1 },
		});
	});

	test('dispatch_response routes a dispatch_result back to the caller', async () => {
		const { room } = await makeRoom();
		const callerWs = await upgrade(room, 'caller');
		const recipientWs = await upgrade(room, 'recipient');

		await room.webSocketMessage(
			callerWs,
			JSON.stringify({
				type: 'dispatch_request',
				id: 'd2',
				to: 'recipient',
				action: 'noop_ping',
			}),
		);
		await room.webSocketMessage(
			recipientWs,
			JSON.stringify({
				type: 'dispatch_response',
				id: 'd2',
				result: { data: 'pong', error: null },
			}),
		);

		const results = jsonFrames(callerWs, 'dispatch_result');
		expect(results).toHaveLength(1);
		expect(results[0]).toMatchObject({
			id: 'd2',
			result: { data: 'pong', error: null },
		});
	});

	test('dispatch_response from a non-recipient socket is ignored', async () => {
		const { room } = await makeRoom();
		const callerWs = await upgrade(room, 'caller');
		const recipientWs = await upgrade(room, 'recipient');
		const impostorWs = await upgrade(room, 'impostor');

		await room.webSocketMessage(
			callerWs,
			JSON.stringify({
				type: 'dispatch_request',
				id: 'd3',
				to: 'recipient',
				action: 'noop_ping',
			}),
		);
		// A peer that is not the dispatch target cannot forge the result, even
		// if it learns the id.
		await room.webSocketMessage(
			impostorWs,
			JSON.stringify({
				type: 'dispatch_response',
				id: 'd3',
				result: { data: 'spoofed', error: null },
			}),
		);
		expect(jsonFrames(callerWs, 'dispatch_result')).toHaveLength(0);

		// The real recipient still resolves it: the pending entry survived the
		// impostor.
		await room.webSocketMessage(
			recipientWs,
			JSON.stringify({
				type: 'dispatch_response',
				id: 'd3',
				result: { data: 'pong', error: null },
			}),
		);
		const results = jsonFrames(callerWs, 'dispatch_result');
		expect(results).toHaveLength(1);
		expect(results[0]).toMatchObject({
			id: 'd3',
			result: { data: 'pong', error: null },
		});
	});
});

describe('Room dispatch: recipient offline', () => {
	test('no live socket for `to`: immediate RecipientOffline result', async () => {
		const { room } = await makeRoom();
		const callerWs = await upgrade(room, 'caller');

		await room.webSocketMessage(
			callerWs,
			JSON.stringify({
				type: 'dispatch_request',
				id: 'd3',
				to: 'ghost',
				action: 'noop_ping',
			}),
		);

		const results = jsonFrames(callerWs, 'dispatch_result');
		expect(results).toHaveLength(1);
		expect(results[0]).toMatchObject({
			id: 'd3',
			result: { error: { name: 'RecipientOffline', to: 'ghost' } },
		});
	});

	test('recipient socket closing mid-dispatch fails the caller', async () => {
		const { room } = await makeRoom();
		const callerWs = await upgrade(room, 'caller');
		const recipientWs = await upgrade(room, 'recipient');

		await room.webSocketMessage(
			callerWs,
			JSON.stringify({
				type: 'dispatch_request',
				id: 'd4',
				to: 'recipient',
				action: 'noop_ping',
			}),
		);
		await room.webSocketClose(recipientWs, 1000, 'bye', true);

		const results = jsonFrames(callerWs, 'dispatch_result');
		expect(results).toHaveLength(1);
		expect(results[0]).toMatchObject({
			id: 'd4',
			result: { error: { name: 'RecipientOffline' } },
		});
	});
});

describe('Room dispatch: malformed frames', () => {
	test('a dispatch_request missing fields is dropped, the socket stays open', async () => {
		const { room } = await makeRoom();
		const callerWs = await upgrade(room, 'caller');

		await room.webSocketMessage(
			callerWs,
			JSON.stringify({ type: 'dispatch_request', id: 'd5' }),
		);

		expect(callerWs.closeCalls).toHaveLength(0);
		expect(jsonFrames(callerWs, 'dispatch_result')).toHaveLength(0);
	});

	test('an unknown text frame type closes the socket with 4400', async () => {
		const { room } = await makeRoom();
		const callerWs = await upgrade(room, 'caller');

		await room.webSocketMessage(
			callerWs,
			JSON.stringify({ type: 'totally_bogus' }),
		);

		expect(callerWs.closeCalls).toHaveLength(1);
		expect(callerWs.closeCalls[0]?.code).toBe(4400);
	});
});
