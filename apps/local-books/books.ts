/**
 * Local Books agent workspace contract: the synced room the client agent loop
 * (ADR-0047) and the Local Books data daemon share. The daemon advertises its
 * read models as dispatched actions (see `mount.ts`); the client runs the loop
 * here and dispatches them.
 *
 * Isomorphic: no `bun:sqlite`, no node APIs. The SQLite mirror is the daemon's
 * private data, reached only as a tool result, never synced; this contract holds
 * just the conversation transcripts.
 */

import { field } from '@epicenter/field';
import {
	attachKvStore,
	defineActions,
	defineTable,
	defineWorkspace,
	generateId,
	type Id,
	type InferTableRow,
} from '@epicenter/workspace';
import type { AgentMessage } from '@epicenter/workspace/agent';
import type { Brand } from 'wellcrafted/brand';

export type ConversationId = Id & Brand<'ConversationId'>;
export const generateConversationId = (): ConversationId =>
	generateId<ConversationId>();

export type MessageId = Id & Brand<'MessageId'>;
export const generateMessageId = (): MessageId => generateId<MessageId>();

/**
 * Conversations: each row's `messages` handle opens a synced child doc, a
 * last-write-wins store of finished {@link AgentMessage} records (ADR-0047). The
 * open client runs the loop and writes each finished message here; the live turn
 * never enters the CRDT.
 */
const conversationsTable = defineTable({
	id: field.string<ConversationId>(),
	title: field.string(),
	createdAt: field.instant(),
	updatedAt: field.instant(),
}).docs({ messages: (ydoc) => attachKvStore<AgentMessage>(ydoc) });
export type Conversation = InferTableRow<typeof conversationsTable>;

export const localBooksWorkspace = defineWorkspace({
	id: 'epicenter-local-books',
	name: 'local-books',
	tables: {
		conversations: conversationsTable,
	},
	kv: {},
	actions: () => defineActions({}),
});
