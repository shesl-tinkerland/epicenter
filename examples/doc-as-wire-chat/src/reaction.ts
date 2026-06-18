/**
 * The reaction (ADR-0014/0015), now over the REAL observe loop (S4).
 *
 * It holds the root workspace doc, runs `attachChildDocReactions` (the production
 * loop from `@epicenter/workspace`) over the `conversations` table, and hosts a
 * live transcript replica for EVERY conversation bound to the agent it answers
 * as (`isDesignated: row.agent === SELF_AGENT`). A conversation bound to any
 * other agent is never opened here, so it is answered only by its own agent.
 *
 * The inference backend is one argument (`startStream`): echo by default, real
 * Gemini when `GEMINI_API_KEY` is set (S5).
 *
 * Run: `bun run src/reaction.ts`  (after the relay is up). Set `AGENT` to change
 * which agent this daemon answers as (default `demo-agent`).
 */

import {
	attachChildDocReactions,
	type ConnectedChildDoc,
} from '@epicenter/workspace';
import { attachChatReaction, attachChatTranscript } from '@epicenter/workspace/ai';
import * as Y from 'yjs';
import {
	agentOf,
	listConversations,
	observeConversations,
	transcriptGuid,
} from './conversations';
import { resolveChatStream } from './inference';
import { connectPeer } from './transport';

const WORKSPACE = process.env.ROOM ?? 'epicenter-demo';
const PORT = process.env.PORT ?? 8787;
const SELF_AGENT = process.env.AGENT ?? 'demo-agent';
const wsUrl = (guid: string) => `ws://localhost:${PORT}/${guid}`;

const startStream = resolveChatStream();

// The root workspace doc: holds the conversations table, synced over its own room.
const rootDoc = new Y.Doc({ gc: true });
connectPeer({
	url: wsUrl(WORKSPACE),
	doc: rootDoc,
	onStatus: (s) => console.log(`[root] ${s}`),
});

// The production observe loop, wired to a relay-backed child-doc connector.
attachChildDocReactions({
	rootDoc,
	table: {
		scan: () => ({
			rows: listConversations(rootDoc).map((row) => ({ id: row.id })),
		}),
		observe: (callback) => observeConversations(rootDoc, callback),
	},
	// Single-owner derivation: the same address the client opener computes.
	guidFor: (rowId) => transcriptGuid(WORKSPACE, rowId),
	// Persist + sync one transcript body. Here that is a relay-backed peer.
	connectBody: (guid): ConnectedChildDoc => {
		const ydoc = new Y.Doc({ gc: true });
		const ws = connectPeer({ url: wsUrl(guid), doc: ydoc });
		const { promise: whenDisposed, resolve } = Promise.withResolvers<void>();
		return {
			ydoc,
			whenDisposed,
			dispose() {
				try {
					ws.close();
				} finally {
					ydoc.destroy();
					resolve();
				}
			},
		};
	},
	layout: (ydoc) => attachChatTranscript(ydoc),
	reactionFor: ({ ydoc, rowId }) => {
		console.log(`▸ hosting "${rowId}" (bound to me) — will answer its turns`);
		return attachChatReaction({ ydoc, startStream });
	},
	// The whole binding: host only conversations addressed to the agent I am.
	isDesignated: (rowId) => agentOf(rootDoc, rowId) === SELF_AGENT,
});

// Narrate every conversation the reaction learns about, designated or not.
const narrated = new Set<string>();
observeConversations(rootDoc, () => {
	for (const conversation of listConversations(rootDoc)) {
		if (narrated.has(conversation.id)) continue;
		narrated.add(conversation.id);
		if (conversation.agent === SELF_AGENT) {
			console.log(
				`+ conversation "${conversation.id}" bound to me ("${conversation.agent}")`,
			);
		} else {
			console.log(
				`· conversation "${conversation.id}" bound to "${conversation.agent}" — ignoring (not my agent)`,
			);
		}
	}
});

console.log(
	`reaction up · answering as agent "${SELF_AGENT}" · workspace "${WORKSPACE}"`,
);
