/**
 * The always-on chat reaction, reconciling a transcript over a REAL room.
 *
 * Every other reaction test drives `onChange` by hand over an in-memory `Y.Doc`
 * with no sync. This suite is the missing end-to-end proof: a daemon peer runs
 * `attachChatReaction` over a transcript body that is synced through a live
 * `createRoomCore` (the same room the Durable Object wraps), and a SEPARATE
 * client peer (the asking device) reads the answer back over that sync. The
 * room core is the relay; the two docs never touch each other directly.
 *
 * Two things it proves that no unit test can:
 *  1. the daemon answers a turn written by another peer, and the streamed reply
 *     propagates back over sync (the V0 exit: "a phone and a desktop see the
 *     same streamed reply over hosted sync");
 *  2. a durable cancel written by another peer stops the answer mid-stream
 *     ("cancel works after a disconnect").
 *
 * The reaction here always answers because the daemon's observe loop only ever
 * builds it for a conversation bound to this daemon's agent (the loop filters by
 * the row's `agent`; see child-doc-reactions.test.ts). The D3 single-answerer
 * guarantee is therefore that loop filter plus the browser skipping its HTTP
 * kickoff for daemon-owned conversations, not anything this reaction decides, so it
 * is proven where each half lives, not here.
 *
 * Peer sync is the same RPC model `doc-generation.test.ts` trusts: a peer pushes
 * its full state with `core.sync(encodeSyncRequest(...))` and applies the diff
 * the room hands back.
 */

import { describe, expect, test } from 'bun:test';
import { field } from '@epicenter/field';
import { encodeSyncRequest } from '@epicenter/sync';
import {
	attachChildDocReactions,
	type ConnectedChildDoc,
	createWorkspace,
	defineTable,
} from '@epicenter/workspace';
import { attachChatReaction, attachChatTranscript } from '@epicenter/workspace/ai';
import { EventType, type StreamChunk } from '@tanstack/ai';
import * as Y from 'yjs';
import type { RoomUpdateLog } from '../room/contracts.js';
import { createRoomCore } from '../room/core.js';

// ────────────────────────────────────────────────────────────────────────────
// Harness
// ────────────────────────────────────────────────────────────────────────────

type RoomCore = ReturnType<typeof createRoomCore>;

function createMemoryUpdateLog(): RoomUpdateLog {
	let entries: Uint8Array[] = [];
	return {
		loadAll: () => entries,
		append: (update) => {
			entries.push(update);
		},
		replaceAll: (compacted) => {
			entries = [compacted];
		},
		byteSize: () => entries.reduce((sum, u) => sum + u.byteLength, 0),
		entryCount: () => entries.length,
	};
}

function textChunk(delta: string): StreamChunk {
	return {
		type: EventType.TEXT_MESSAGE_CONTENT,
		messageId: 'm',
		delta,
	} as StreamChunk;
}

/** A stream that yields each delta with a microtask gap, then ends. */
function streamOf(...deltas: string[]) {
	return async function* (): AsyncGenerator<StreamChunk> {
		for (const delta of deltas) {
			yield textChunk(delta);
			await Promise.resolve();
		}
	};
}

/** A stream that yields `first `, parks until `release()`, then yields `second`. */
function gatedStream() {
	const gate = Promise.withResolvers<void>();
	return {
		startStream: async function* (): AsyncGenerator<StreamChunk> {
			yield textChunk('first ');
			await gate.promise;
			yield textChunk('second');
		},
		release: gate.resolve,
	};
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * One bidirectional sync step for a peer: push its full state to the room, then
 * apply the diff the room is missing back. PUSH happens before APPLY, so a claim
 * the peer makes while applying the inbound update lands in the room only on the
 * NEXT step.
 */
function syncStep(doc: Y.Doc, core: RoomCore): void {
	const { data, error } = core.sync(
		encodeSyncRequest(Y.encodeStateVector(doc), Y.encodeStateAsUpdateV2(doc)),
	);
	if (error) throw error;
	if (data.diff) Y.applyUpdateV2(doc, data.diff);
}

/** Sync every peer, advancing async streams between rounds, until `done()`. */
async function pumpUntil(
	done: () => boolean,
	peers: Y.Doc[],
	core: RoomCore,
	maxRounds = 80,
): Promise<void> {
	for (let round = 0; round < maxRounds; round++) {
		for (const peer of peers) syncStep(peer, core);
		if (done()) return;
		await tick();
	}
	for (const peer of peers) syncStep(peer, core);
	if (!done())
		throw new Error(`pumpUntil: condition not met in ${maxRounds} rounds`);
}

/**
 * Wire `attachChatReaction` to a body and fire `onChange` on every transaction.
 *
 * This stands in for the daemon's observe loop, which builds the reaction only for a
 * designated conversation; the reaction itself has no designation concept, so the
 * harness just attaches it to the body.
 */
function attachDaemon(
	ydoc: Y.Doc,
	startStream: Parameters<typeof attachChatReaction>[0]['startStream'],
) {
	const transcript = attachChatTranscript(ydoc);
	const reaction = attachChatReaction({ ydoc, startStream });
	const unobserve = transcript.observe(() => reaction.onChange?.());
	return {
		transcript,
		dispose() {
			unobserve();
			reaction[Symbol.dispose]?.();
		},
	};
}

const assistantsFor = (
	transcript: { read(): { role: string; id: string }[] },
	generationId: string,
) =>
	transcript
		.read()
		.filter((m) => m.role === 'assistant' && m.id === generationId);

// ────────────────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────────────────

describe('chat reaction over real room sync', () => {
	test('the daemon answers a turn written by another peer, and the reply syncs back', async () => {
		const core = createRoomCore({ updateLog: createMemoryUpdateLog() });

		// The always-on daemon peer: a body synced through the room.
		const daemonDoc = new Y.Doc({ gc: true });
		const daemon = attachDaemon(daemonDoc, streamOf('你', '好', '!'));

		// The asking device: a separate body, same room.
		const clientDoc = new Y.Doc({ gc: true });
		const client = attachChatTranscript(clientDoc);

		// The client asks and syncs the turn up. It never calls an HTTP kickoff.
		client.appendUser({
			id: 'u1',
			content: 'hi',
			createdAt: 1,
			generationId: 'gen-1',
		});
		syncStep(clientDoc, core);

		// Drive sync until the asking device sees a finished answer.
		await pumpUntil(
			() => client.read().find((m) => m.id === 'gen-1')?.finish !== undefined,
			[daemonDoc, clientDoc],
			core,
		);

		const messages = client.read();
		expect(messages).toHaveLength(2);
		expect(messages[1]).toMatchObject({
			id: 'gen-1',
			role: 'assistant',
			text: '你好!',
			finish: { kind: 'completed' },
		});
		// Exactly one answer: the single designated reaction did not double-stream.
		expect(assistantsFor(client, 'gen-1')).toHaveLength(1);

		daemon.dispose();
		daemonDoc.destroy();
		clientDoc.destroy();
	});

	test('a durable cancel from another peer stops the daemon mid-answer, over sync', async () => {
		const core = createRoomCore({ updateLog: createMemoryUpdateLog() });
		const { startStream, release } = gatedStream();

		const daemonDoc = new Y.Doc({ gc: true });
		const daemon = attachDaemon(daemonDoc, startStream);

		const clientDoc = new Y.Doc({ gc: true });
		const client = attachChatTranscript(clientDoc);

		client.appendUser({
			id: 'u1',
			content: 'hi',
			createdAt: 1,
			generationId: 'gen-1',
		});
		syncStep(clientDoc, core);

		// The daemon claims and streams `first `, then parks at the gate.
		await pumpUntil(
			() => client.read().find((m) => m.id === 'gen-1')?.text === 'first ',
			[daemonDoc, clientDoc],
			core,
		);

		// The asking device cancels durably (no HTTP fetch to abort) and syncs it.
		client.requestCancel(2);
		syncStep(clientDoc, core);

		// The daemon reads the cancel back over sync and finishes cancelled.
		await pumpUntil(
			() => client.read().find((m) => m.id === 'gen-1')?.finish !== undefined,
			[daemonDoc, clientDoc],
			core,
		);

		release(); // unpark the abandoned generator; the aborted loop drops `second`
		await tick();
		syncStep(daemonDoc, core);
		syncStep(clientDoc, core);

		const answer = client.read().find((m) => m.id === 'gen-1');
		expect(answer?.finish).toEqual({ kind: 'cancelled' });
		expect(answer?.text).toBe('first ');

		daemon.dispose();
		daemonDoc.destroy();
		clientDoc.destroy();
	});

	// ──────────────────────────────────────────────────────────────────────────
	// Test 3: designation over real sync (the V0 "0 duplicate streams" claim in
	// the real composition). Tests 1-2 prove a single daemon answers and honors a
	// cancel; neither exercises designation, because the harness attaches the
	// reaction straight to a body. This one runs the REAL observe loop
	// (`attachChildDocReactions`) over a table of two conversations bound to two
	// different agents, composed exactly as the Zhongwen mount does
	// (`isDesignated = row.agent === selfAgentId`, `layout = attachChatTranscript`,
	// `reactionFor = attachChatReaction`). It proves the daemon answers ONLY the
	// conversation bound to its agent and never even opens the other, so a turn for
	// another agent is left to that agent (the browser's cloud path), never
	// double-answered here.
	// ──────────────────────────────────────────────────────────────────────────
	test('the daemon answers only the conversation bound to its agent, over sync', async () => {
		const SELF_AGENT = 'zhongwen-home';

		// One `createRoomCore` is one logical room, so each synced doc gets its own
		// core: the root table is one room, each transcript body another. This is
		// the same one-core-per-body shape tests 1-2 use, extended to the root.
		const rootCore = createRoomCore({ updateLog: createMemoryUpdateLog() });
		const childCores = new Map<string, RoomCore>();
		const coreFor = (guid: string): RoomCore => {
			const existing = childCores.get(guid);
			if (existing) return existing;
			const core = createRoomCore({ updateLog: createMemoryUpdateLog() });
			childCores.set(guid, core);
			return core;
		};

		// A conversation table mirroring Zhongwen's: each row carries an immutable
		// bound `agent`, and `messages` is a transcript child doc keyed by row id.
		const conversations = defineTable({
			id: field.string(),
			agent: field.string(),
		}).docs({ messages: attachChatTranscript });

		// Two peers, each its own workspace synced through `rootCore`: the asking
		// client and the always-on daemon.
		const clientWs = createWorkspace({
			id: 'ws-designation',
			tables: { conversations },
			kv: {},
		});
		const daemonWs = createWorkspace({
			id: 'ws-designation',
			tables: { conversations },
			kv: {},
		});

		// The client opens two conversations: one bound to the daemon's agent, one
		// bound to the cloud agent the browser would answer over HTTP.
		clientWs.tables.conversations.set({ id: 'home', agent: SELF_AGENT });
		clientWs.tables.conversations.set({
			id: 'cloud',
			agent: 'epicenter-cloud',
		});

		const homeGuid = clientWs.tables.conversations.docs.messages.guid('home');

		// The daemon runs the real observe loop, designated to SELF_AGENT. Each
		// hosted body is a fresh Y.Doc synced through its per-guid core; the set of
		// opened bodies is the proof of which conversations the loop hosted.
		const daemonBodies: Y.Doc[] = [];
		const reaction = attachChildDocReactions({
			rootDoc: daemonWs.ydoc,
			table: daemonWs.tables.conversations,
			guidFor: daemonWs.tables.conversations.docs.messages.guid,
			connectBody: (guid): ConnectedChildDoc => {
				const ydoc = new Y.Doc({ guid, gc: true });
				daemonBodies.push(ydoc);
				const { promise: whenDisposed, resolve } =
					Promise.withResolvers<void>();
				ydoc.once('destroy', () => resolve());
				return { ydoc, whenDisposed, dispose: () => ydoc.destroy() };
			},
			layout: attachChatTranscript,
			reactionFor: ({ ydoc }) =>
				attachChatReaction({ ydoc, startStream: streamOf('你', '好', '!') }),
			isDesignated: (rowId) =>
				daemonWs.tables.conversations.get(rowId).data?.agent === SELF_AGENT,
		});

		// The client writes a user turn into the home transcript. Designation is
		// decided on the root row's agent, never the transcript, so the cloud
		// conversation needs no body here: its root row alone is what the daemon
		// must see and skip.
		const homeClientBody = new Y.Doc({ guid: homeGuid, gc: true });
		const homeClient = attachChatTranscript(homeClientBody);
		homeClient.appendUser({
			id: 'u1',
			content: 'hi',
			createdAt: 1,
			generationId: 'gen-home',
		});

		// Pump the root table first so the daemon sees the rows and their agents and
		// reconciles its hosted set, then every body through its own core. A daemon
		// body opened mid-pump joins `daemonBodies` and syncs from the next round.
		const pump = (): void => {
			syncStep(daemonWs.ydoc, rootCore);
			syncStep(clientWs.ydoc, rootCore);
			syncStep(homeClientBody, coreFor(homeGuid));
			for (const body of daemonBodies) syncStep(body, coreFor(body.guid));
		};
		for (let round = 0; round < 80; round++) {
			pump();
			if (
				homeClient.read().find((m) => m.id === 'gen-home')?.finish !== undefined
			)
				break;
			await tick();
		}

		// The home conversation: exactly one finished answer, streamed by the daemon.
		const homeMessages = homeClient.read();
		expect(homeMessages).toHaveLength(2);
		expect(homeMessages[1]).toMatchObject({
			id: 'gen-home',
			role: 'assistant',
			text: '你好!',
			finish: { kind: 'completed' },
		});
		expect(
			homeMessages.filter((m) => m.role === 'assistant' && m.id === 'gen-home'),
		).toHaveLength(1);

		// The daemon hosted exactly the designated conversation: it saw the cloud
		// row in the root table and skipped it, never opening that transcript. The
		// hosted set is the direct evidence of the single-answerer guarantee.
		expect(daemonBodies.map((body) => body.guid)).toEqual([homeGuid]);

		reaction[Symbol.dispose]();
		daemonWs[Symbol.dispose]();
		clientWs[Symbol.dispose]();
		homeClientBody.destroy();
	});
});
