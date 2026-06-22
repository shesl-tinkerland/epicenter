/**
 * Vocab's conversation controller: the one client agent loop (ADR-0047) bound to
 * Svelte state, with no tools.
 *
 * Vocab is capability-free, so the open tab answers its own turns over the
 * metered inference stream: the loop streams the live turn into component state
 * and never into the synced doc, and writes each finished message to the
 * conversation's last-write-wins store keyed by message id (ADR-0046). A stopped
 * or failed turn persists nothing; the durable user turn is left to retry.
 *
 * Vocab adds nothing to the loop beyond a capability-free engine; the tool
 * surface is empty, so the loop runs a single text step per turn.
 */

import { bindAgentConversation } from '@epicenter/svelte';
import { generateMessageId, type VocabMessage } from '@epicenter/vocab';
import type { KvStoreHandle } from '@epicenter/workspace';
import {
	type AgentEngine,
	createConversation as createAgentConversation,
} from '@epicenter/workspace/agent';

/** The opened `conversations.messages` child-doc handle (keyed by message id). */
type MessageStore = KvStoreHandle<VocabMessage> & Disposable;

/**
 * Bind one conversation's message store to the inference engine.
 *
 * @param store  the opened `tables.conversations.docs.messages.open(id)` handle.
 * @param engine the client's inference backend (the metered Epicenter engine).
 */
export function createConversation(store: MessageStore, engine: AgentEngine) {
	return bindAgentConversation(
		createAgentConversation({
			store,
			engine,
			generateId: generateMessageId,
		}),
	);
}
