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
 *      → `openZhongwenBrowser({ signedIn, nodeId })`
 *  - `apps/zhongwen/mount.ts` → `zhongwen()` mount factory
 */

import type { ServableModel } from '@epicenter/constants/ai-providers';
import { field } from '@epicenter/field';
import {
	type AgentId,
	asAgentId,
	defineKv,
	defineTable,
	defineWorkspace,
	generateId,
	type Id,
	type InferTableRow,
} from '@epicenter/workspace';
import { attachChatTranscript } from '@epicenter/workspace/ai';
import { Type } from 'typebox';
import type { Brand } from 'wellcrafted/brand';

// ─────────────────────────────────────────────────────────────────────────────
// Branded ID Types
// ─────────────────────────────────────────────────────────────────────────────

export type ConversationId = Id & Brand<'ConversationId'>;
export const generateConversationId = (): ConversationId =>
	generateId<ConversationId>();

/**
 * Zhongwen runs a single Chinese-tuned model. It is an app constant, not a
 * per-conversation choice, so it is never stored on the conversation row. Both
 * answer paths read it: the browser sends it with the HTTP kickoff (the server
 * derives the provider from the catalog), and the always-on daemon reaction builds
 * its Gemini adapter from it directly.
 */
export const ZHONGWEN_MODEL = 'gemini-3.5-flash' satisfies ServableModel;

/**
 * The hosted cloud agent's stable address (ADR-0015). A new conversation is bound
 * to this agent, so the cloud generation path (the metered HTTP route) answers it.
 * The binding is immutable: to talk to a different agent you fork the conversation,
 * so a conversation's history only ever reaches its one bound agent. An always-on
 * daemon answers instead when a conversation is bound to that daemon's agent id.
 */
export const CLOUD_AGENT_ID: AgentId = asAgentId('epicenter-cloud');

// Re-export the agent address type so app UI binds against one import surface
// (`@epicenter/zhongwen`) for the agent catalog and the ids it hands the picker.
export type { AgentId };

/**
 * One agent Zhongwen can bind a conversation to: its durable {@link AgentId},
 * a display `label` for the picker, the `model` it answers with, the action keys
 * it may call as tools (ADR-0010; none yet), and where its runtime lives.
 *
 * `runtime` is the routing fork the browser reads: a `'cloud'` agent answers over
 * the metered HTTP route, so the browser nudges it; a `'daemon'` agent is an
 * always-on reaction that answers over sync, so the browser stays out of the way
 * (nudging both would answer one turn twice, the D3 hazard). The catalog is the
 * one place that fork is declared.
 */
export type AgentConfig = {
	readonly id: AgentId;
	readonly label: string;
	readonly model: ServableModel;
	readonly tools: readonly string[];
	readonly runtime: 'cloud' | 'daemon';
};

/**
 * The agents a Zhongwen conversation can be bound to (ADR-0015). Config, not
 * presence: the picker lists every entry here whether or not its runtime is live,
 * because the conversation doc is a durable mailbox: a turn bound to an offline
 * daemon waits in the doc until that daemon wakes and answers. Presence only ever
 * decorates this list with a live/offline hint; it never gates what can be bound.
 *
 * The hosted cloud agent is always available (its runtime is the serverless
 * route). The home daemon is the always-on reaction a user co-deploys; binding a
 * conversation to it is what a later "co-deploy a live daemon" slice brings online.
 */
export const ZHONGWEN_AGENTS = [
	{
		id: CLOUD_AGENT_ID,
		label: 'Epicenter Cloud',
		model: ZHONGWEN_MODEL,
		tools: [],
		runtime: 'cloud',
	},
	{
		id: asAgentId('zhongwen-home'),
		label: 'Home daemon',
		model: ZHONGWEN_MODEL,
		tools: [],
		runtime: 'daemon',
	},
] as const satisfies readonly AgentConfig[];

/**
 * The agent a new conversation binds to when the user does not pick one: the
 * always-available cloud agent, so the fast "New Conversation" path answers with
 * no daemon required.
 */
export const DEFAULT_AGENT_ID: AgentId = CLOUD_AGENT_ID;

/**
 * The catalog entry for a bound `agent`, or `undefined` for an id no longer in
 * the catalog (a conversation bound before the agent was removed). Callers read
 * `runtime` to route: `agentConfig(id)?.runtime === 'cloud'` is "the browser
 * answers this one"; anything else is left to a daemon over sync.
 */
export function agentConfig(id: AgentId): AgentConfig | undefined {
	return ZHONGWEN_AGENTS.find((agent) => agent.id === id);
}

/**
 * The bilingual system prompt every Zhongwen answer is generated under. An app
 * constant like {@link ZHONGWEN_MODEL}, shared by both answer paths so they
 * produce the same voice: the browser sends it with the HTTP kickoff, and the
 * always-on daemon reaction passes it to its provider. It lives here, in the
 * isomorphic contract, rather than in a route folder so the node daemon can read
 * it without importing browser code.
 */
export const ZHONGWEN_SYSTEM_PROMPT = `You are a bilingual Chinese-English language assistant. Your responses mix English and Mandarin Chinese naturally.

Guidelines:
- Use English for explanations, transitions, and meta-commentary
- Use Mandarin Chinese (simplified characters only, 简体字) for vocabulary, example sentences, and conversational phrases
- Never include pinyin in your responses: the client adds it automatically above each character
- Never use traditional characters (繁體字)
- When teaching vocabulary, present the Chinese naturally inline: "The word 学习 means to study"
- For example sentences, write them in Chinese then explain in English
- Adjust difficulty based on context clues from the user's questions
- Be conversational and encouraging

Example response style:
"The phrase 你好 is the most common greeting. For something more casual with friends, you can say 嘿 or 哈喽. In a formal setting, try 您好. The 您 shows extra respect."`;

// ─────────────────────────────────────────────────────────────────────────────
// Table Definitions
// ─────────────────────────────────────────────────────────────────────────────

const conversationsTable = defineTable({
	id: field.string<ConversationId>(),
	title: field.string(),
	createdAt: field.instant(),
	updatedAt: field.instant(),
	/**
	 * The agent this conversation is bound to (ADR-0015), set once at creation and
	 * never reassigned. {@link CLOUD_AGENT_ID} routes to the cloud generation path
	 * (the browser nudges the HTTP route); a daemon's agent id routes to that
	 * always-on reaction over sync, and the browser skips its kickoff. One immutable
	 * field is who was addressed and who answered, for every turn: the history
	 * cannot disagree with itself, and the conversation's content only ever reaches
	 * this one agent. Switching agents is a fork, not a write here.
	 */
	agent: field.string<AgentId>(),
}).docs({ messages: attachChatTranscript });
export type Conversation = InferTableRow<typeof conversationsTable>;

// ─────────────────────────────────────────────────────────────────────────────
// Workspace Factory
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The isomorphic Zhongwen workspace definition.
 *
 * Conversation transcripts are not rows: each `conversations.messages` handle
 * opens a synced child doc derived from the conversation id and streamed into
 * by the server generation reaction.
 */
export const zhongwenWorkspace = defineWorkspace({
	id: 'epicenter-zhongwen',
	name: 'zhongwen',
	tables: {
		conversations: conversationsTable,
	},
	kv: {
		showPinyin: defineKv(Type.Boolean(), () => true),
	},
});
