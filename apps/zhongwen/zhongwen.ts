/**
 * Zhongwen workspace contract: id, branded types, tables, kv, actions, and
 * the workspace factory. Isomorphic: no IndexedDB, WebSockets, Svelte state,
 * browser APIs, or daemon process lifecycle.
 *
 * Distribution: this file is the `@epicenter/zhongwen` package root file
 * (the target of the package's `"."` export). Browser and daemon entrypoints
 * import the schema from here and compose runtime-specific attachments
 * around it. The table and KV shapes here are the wire contract for sync;
 * forking a column shape breaks sync compatibility with peers running the
 * canonical schema.
 *
 * Composition lives elsewhere:
 *  - `apps/zhongwen/zhongwen.browser.ts`
 *      → `openZhongwenBrowser({ signedIn, deviceId })`
 *  - `apps/zhongwen/project.ts` → `zhongwen()` mount factory
 */

import {
	column,
	createWorkspace,
	defineActions,
	defineKv,
	defineTable,
	defineWorkspace,
	generateId,
	type Id,
	type InferTableRow,
	type Keyring,
} from '@epicenter/workspace';
import { Type } from 'typebox';
import type { Brand } from 'wellcrafted/brand';
import type { JsonValue } from 'wellcrafted/json';

export const ZHONGWEN_ID = 'epicenter.zhongwen';

// ─────────────────────────────────────────────────────────────────────────────
// Branded ID Types
// ─────────────────────────────────────────────────────────────────────────────

export type ConversationId = Id & Brand<'ConversationId'>;
export const generateConversationId = (): ConversationId =>
	generateId<ConversationId>();
/**
 * Syntactic sugar for `value as ConversationId`. The constrained `string` parameter
 * is what earns it over a raw `as` cast (callers can't widen to `unknown`).
 * The only place in the codebase where `as ConversationId` should appear.
 */
export const asConversationId = (value: string): ConversationId =>
	value as ConversationId;

export type ChatMessageId = Id & Brand<'ChatMessageId'>;
export const generateChatMessageId = (): ChatMessageId =>
	generateId<ChatMessageId>();
/**
 * Syntactic sugar for `value as ChatMessageId`. The constrained `string` parameter
 * is what earns it over a raw `as` cast (callers can't widen to `unknown`).
 * The only place in the codebase where `as ChatMessageId` should appear.
 */
export const asChatMessageId = (value: string): ChatMessageId =>
	value as ChatMessageId;

// ─────────────────────────────────────────────────────────────────────────────
// Table Definitions
// ─────────────────────────────────────────────────────────────────────────────

const conversationsTable = defineTable({
	id: column.string<ConversationId>(),
	title: column.string(),
	provider: column.string(),
	model: column.string(),
	createdAt: column.number(),
	updatedAt: column.number(),
});
export type Conversation = InferTableRow<typeof conversationsTable>;

const chatMessagesTable = defineTable({
	id: column.string<ChatMessageId>(),
	conversationId: column.string<ConversationId>(),
	role: column.enum(['user', 'assistant']),
	parts: column.json(Type.Array(Type.Unsafe<JsonValue>(Type.Any()))),
	createdAt: column.number(),
});
export type ChatMessage = InferTableRow<typeof chatMessagesTable>;

const zhongwenTables = {
	conversations: conversationsTable,
	chatMessages: chatMessagesTable,
};

const zhongwenKv = {
	showPinyin: defineKv(Type.Boolean(), () => true),
};

// ─────────────────────────────────────────────────────────────────────────────
// Workspace Factory
// ─────────────────────────────────────────────────────────────────────────────

export function createZhongwenWorkspace(opts: { keyring: () => Keyring }) {
	const workspace = createWorkspace({
		id: ZHONGWEN_ID,
		keyring: opts.keyring,
		tables: zhongwenTables,
		kv: zhongwenKv,
	});
	const actions = defineActions({});

	return defineWorkspace({
		...workspace,
		actions,
		[Symbol.dispose]() {
			workspace[Symbol.dispose]();
		},
	});
}
export type ZhongwenWorkspace = ReturnType<typeof createZhongwenWorkspace>;
