/**
 * A minimal `conversations` table over the root workspace doc, plus the derived
 * child-doc address grammar. This stands in for the full workspace schema; the
 * point of the demo is the observe loop and the binding, not the table machinery.
 *
 * Each row is one human + one agent, for life (ADR-0025): an immutable `agent`
 * set once at creation. The transcript is a SEPARATE child doc whose guid is
 * DERIVED from the row id (the 4-part grammar from `doc-guid.ts`), so the actor
 * and every client compute the identical address with zero coordination.
 */

import * as Y from 'yjs';

const KEY = 'conversations';

export type ConversationRow = { id: string; agent: string };

function rows(doc: Y.Doc): Y.Array<Y.Map<string>> {
	return doc.getArray<Y.Map<string>>(KEY);
}

/** Create the conversation row once. Idempotent: a row with `id` is left as-is. */
export function ensureConversation(doc: Y.Doc, row: ConversationRow): void {
	if (listConversations(doc).some((existing) => existing.id === row.id)) return;
	doc.transact(() => {
		const map = new Y.Map<string>();
		map.set('id', row.id);
		map.set('agent', row.agent);
		rows(doc).push([map]);
	});
}

/** Snapshot every conversation row. */
export function listConversations(doc: Y.Doc): ConversationRow[] {
	return rows(doc)
		.toArray()
		.map((map) => ({
			id: map.get('id') as string,
			agent: map.get('agent') as string,
		}));
}

/** Observe row adds/removes. Returns the unobserve function. */
export function observeConversations(
	doc: Y.Doc,
	callback: () => void,
): () => void {
	const array = rows(doc);
	const handler = () => callback();
	array.observe(handler);
	return () => array.unobserve(handler);
}

/** The agent a conversation is bound to, or `undefined` if the row is unknown. */
export function agentOf(doc: Y.Doc, rowId: string): string | undefined {
	return listConversations(doc).find((row) => row.id === rowId)?.agent;
}

/**
 * Derive a conversation's transcript child-doc guid: the canonical 4-part
 * `${workspaceId}.${collection}.${rowId}.${field}` address. The single-owner
 * derivation is why the actor's observe loop and the client opener land on the
 * same room.
 */
export function transcriptGuid(workspaceId: string, rowId: string): string {
	return `${workspaceId}.conversations.${rowId}.transcript`;
}
