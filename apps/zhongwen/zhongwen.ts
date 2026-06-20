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
import {
	attachChatConversation,
	type ChatStream,
} from '@epicenter/workspace/ai';
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
 * answer paths read it: the browser passes it to the Epicenter provider it answers
 * cloud conversations with (the metered `/api/ai/chat` stream), and the always-on
 * daemon worker builds its Gemini adapter from it directly.
 */
export const ZHONGWEN_MODEL = 'gemini-3.5-flash' satisfies ServableModel;

/**
 * The ephemeral agent's stable address (ADR-0025): the one the open browser tab
 * owns and answers in-process, sourcing tokens from the metered `/api/ai/chat`
 * stream via the Epicenter provider (ADR-0033). The id names the *owner* (the
 * device's tab, which is why the answer stops when you close it), not the engine
 * (the cloud credits the tokens are billed to): owner ⊥ engine. A new conversation
 * binds to this agent by default. The binding is immutable: to talk to a different
 * agent you fork the conversation, so a conversation's history only ever reaches
 * its one bound agent. An always-on daemon answers instead when a conversation is
 * bound to that daemon's agent id.
 */
export const THIS_DEVICE_AGENT_ID: AgentId = asAgentId('this-device');

// Re-export the agent address type so app UI binds against one import surface
// (`@epicenter/zhongwen`) for the agent catalog and the ids it hands the picker.
export type { AgentId };

/**
 * One agent Zhongwen can bind a conversation to: its durable {@link AgentId},
 * a display `label` for the picker, the `model` it answers with, the action keys
 * it may call as tools (ADR-0021; none yet), and the `owner` kind that writes its
 * conversations.
 *
 * `owner` is the routing fork the browser reads, and it names who writes the
 * transcript, not where tokens come from (ADR-0025). An `'ephemeral'` agent
 * (`this-device`) is owned by the open browser tab, which answers in-process
 * and stops when it closes. A `'durable'` agent is an always-on resident daemon,
 * which answers over sync and survives the tab closing, so the browser stays out
 * of the way (both answering would answer one turn twice, the D3 hazard). The
 * engine each writer uses (a local key, the user's metered account) is an
 * orthogonal sub-choice it resolves for itself (ADR-0038), never a property of
 * the owner. The catalog is the one place the owner fork is declared (ADR-0033).
 */
export type AgentConfig = {
	readonly id: AgentId;
	readonly label: string;
	readonly model: ServableModel;
	readonly tools: readonly string[];
	readonly owner: 'ephemeral' | 'durable';
};

/**
 * The agents a Zhongwen conversation can be bound to (ADR-0025). Config, not
 * presence: the picker lists every entry here whether or not its runtime is live,
 * because the conversation doc is a durable mailbox: a turn bound to an offline
 * daemon waits in the doc until that daemon wakes and answers. Presence only ever
 * decorates this list with a live/offline hint; it never gates what can be bound.
 *
 * The this-device agent is always available (the open tab answers it in-process
 * against the hosted inference stream, no daemon required). The home daemon is the
 * always-on worker a user co-deploys; binding a
 * conversation to it is what a later "co-deploy a live daemon" slice brings online.
 */
export const ZHONGWEN_AGENTS = [
	{
		id: THIS_DEVICE_AGENT_ID,
		label: 'This device',
		model: ZHONGWEN_MODEL,
		tools: [],
		owner: 'ephemeral',
	},
	{
		id: asAgentId('zhongwen-home'),
		label: 'Home daemon',
		model: ZHONGWEN_MODEL,
		tools: [],
		owner: 'durable',
	},
] as const satisfies readonly AgentConfig[];

/**
 * The agent a new conversation binds to when the user does not pick one: the
 * always-available this-device agent, so the fast "New Conversation" path answers
 * with no daemon required.
 */
export const DEFAULT_AGENT_ID: AgentId = THIS_DEVICE_AGENT_ID;

/**
 * The catalog entry for a bound `agent`, or `undefined` for an id no longer in
 * the catalog (a conversation bound before the agent was removed). Callers read
 * `owner` to route: an `'ephemeral'` agent the browser answers in-process; a
 * `'durable'` agent is left to its resident daemon over sync.
 */
export function agentConfig(id: AgentId): AgentConfig | undefined {
	return ZHONGWEN_AGENTS.find((agent) => agent.id === id);
}

/**
 * One inference backend a peer can power, built lazily: it returns a
 * {@link ChatStream} when the host can satisfy it (a key is present, the account
 * is opted in) or `null` when it cannot, so {@link resolveEngine} can fall
 * through to the next engine in priority order (ADR-0038).
 */
export type Engine = () => ChatStream | null;

/**
 * The `ChatStream` to answer with, taken from the first engine this host can
 * power, or `null` when it can power none: host the conversation's sync, write
 * nothing, leave the turn for a configured answerer.
 *
 * This is only the *engine* half of answering, where tokens come from. The other
 * half, *designation* (is this turn mine to write?), is the owner fork and is
 * decided where each peer naturally decides it, never here: a daemon's observe
 * loop hosts only the conversations bound to its agent (`row.agent ===
 * selfAgentId`, ADR-0025), so by the time it resolves an engine the turn is
 * already its own; a browser tab reads the bound agent's `owner` kind before it
 * mounts an answerer at all. The two halves are orthogonal (owner ⊥ engine,
 * ADR-0033/0038), so they are not forced through one function: doing so made the
 * daemon's designation a tautology (it would only ever pass its own agent).
 */
export function resolveEngine(engines: readonly Engine[]): ChatStream | null {
	for (const engine of engines) {
		const stream = engine();
		if (stream) return stream; // first engine this host can power
	}
	return null; // no engine here → host, don't answer
}

/**
 * The bilingual system prompt every Zhongwen answer is generated under. An app
 * constant like {@link ZHONGWEN_MODEL}, shared by both answer paths so they
 * produce the same voice: the browser passes it to the Epicenter provider, and the
 * always-on daemon worker passes it to its provider. It lives here, in the
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
	 * The agent this conversation is bound to (ADR-0025), set once at creation and
	 * never reassigned. {@link THIS_DEVICE_AGENT_ID} routes to the browser answering
	 * in-process (the Epicenter provider); a daemon's agent id routes to that
	 * always-on worker over sync, and the browser stays out. One immutable
	 * field is who was addressed and who answered, for every turn: the history
	 * cannot disagree with itself, and the conversation's content only ever reaches
	 * this one agent. Switching agents is a fork, not a write here.
	 */
	agent: field.string<AgentId>(),
}).docs({ messages: attachChatConversation });
export type Conversation = InferTableRow<typeof conversationsTable>;

// ─────────────────────────────────────────────────────────────────────────────
// Workspace Factory
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The isomorphic Zhongwen workspace definition.
 *
 * Conversation transcripts are not rows: each `conversations.messages` handle
 * opens a synced child doc derived from the conversation id and streamed into
 * by the server generation worker.
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
