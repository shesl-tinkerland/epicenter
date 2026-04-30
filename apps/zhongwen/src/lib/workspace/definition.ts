/**
 * Workspace schema — branded IDs and table/kv definitions.
 *
 * Browser-agnostic: no IndexedDB, no Svelte imports, no Y.Doc construction.
 * The Y.Doc and attachments live in `lib/zhongwen/core.ts` (iso) and
 * `lib/zhongwen/browser.ts` (env-bound), composed through `openZhongwen`.
 */

import {
	defineKv,
	defineTable,
	generateId,
	type Id,
	type InferTableRow,
} from '@epicenter/workspace';
import { type } from 'arktype';
import type { Brand } from 'wellcrafted/brand';
import type { JsonValue } from 'wellcrafted/json';

// ─────────────────────────────────────────────────────────────────────────────
// Branded ID Types
// ─────────────────────────────────────────────────────────────────────────────

export type ConversationId = Id & Brand<'ConversationId'>;
export const ConversationId = type('string').as<ConversationId>();
export const generateConversationId = (): ConversationId =>
	generateId() as ConversationId;

export type ChatMessageId = Id & Brand<'ChatMessageId'>;
export const ChatMessageId = type('string').as<ChatMessageId>();
export const generateChatMessageId = (): ChatMessageId =>
	generateId() as ChatMessageId;

// ─────────────────────────────────────────────────────────────────────────────
// Table Definitions
// ─────────────────────────────────────────────────────────────────────────────

const conversationsTable = defineTable(
	type({
		id: ConversationId,
		title: 'string',
		provider: 'string',
		model: 'string',
		createdAt: 'number',
		updatedAt: 'number',
		_v: '1',
	}),
);
export type Conversation = InferTableRow<typeof conversationsTable>;

const chatMessagesTable = defineTable(
	type({
		id: ChatMessageId,
		conversationId: ConversationId,
		role: "'user' | 'assistant'",
		parts: type({} as type.cast<JsonValue[]>),
		createdAt: 'number',
		_v: '1',
	}),
);
export type ChatMessage = InferTableRow<typeof chatMessagesTable>;

// ─────────────────────────────────────────────────────────────────────────────
// Schema Records
// ─────────────────────────────────────────────────────────────────────────────

export const zhongwenTables = {
	conversations: conversationsTable,
	chatMessages: chatMessagesTable,
};

export const zhongwenKv = {
	showPinyin: defineKv(type('boolean'), true),
};
