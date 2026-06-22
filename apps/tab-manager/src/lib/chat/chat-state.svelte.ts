/**
 * Reactive AI chat state with multi-conversation support.
 *
 * Architecture: the one client agent loop (ADR-0047/0051), one
 * `createConversation` per conversation, persisted to a device-local IndexedDB
 * store (`attachConversationStore`). tab-manager runs no synced Yjs transcript:
 * the loop's store seam takes the IndexedDB-backed `KvStoreHandle`, so chat stays
 * device-local with no CRDT cost while sharing the single loop every other
 * surface uses (ADR-0051 retires the separate TanStack `createChat` loop).
 *
 * Inference rides the OpenAI-compatible gateway (ADR-0049/0050): the engine POSTs
 * `/v1/chat/completions`, reading the conversation's model and the device system
 * prompts per turn. Tools are tab-manager's own browser actions, surfaced through
 * `createDispatchToolCatalog` (a local action resolves through `invokeAction`
 * with no relay). A mutation is approval-gated by a synchronous pause; the
 * "Always Allow" trust set decides `auto` so a trusted tool never pauses again.
 *
 * The handle registry is the conversation list: it hydrates once from the
 * IndexedDB chat store at startup, and from then on creates and deletes go
 * through the registry, with message bodies persisted by each conversation's
 * store. A new conversation is an in-memory draft until its first message lands,
 * so empty chats are never stored. Titles and recency derive from the messages
 * themselves; the only stored metadata is the per-conversation model pick.
 *
 * Components read this through `workspace.state.aiChat`.
 */

import type { AuthClient } from '@epicenter/auth';
import { createOpenAiAgentEngine } from '@epicenter/client';
import { API_ROUTES } from '@epicenter/constants/api-routes';
import { APP_URLS } from '@epicenter/constants/vite';
import { bindAgentConversation } from '@epicenter/svelte';
import { type Collaboration, generateId } from '@epicenter/workspace';
import {
	type AgentToolCall,
	agentMessageText,
	createConversation as createAgentConversation,
	createDispatchToolCatalog,
	defaultApprovalDecision,
} from '@epicenter/workspace/agent';
import { SvelteMap } from 'svelte/reactivity';
import { DEFAULT_MODEL } from '$lib/chat/models';
import {
	attachConversationStore,
	type ConversationId,
	clearConversation,
	deleteModelChoice,
	generateConversationId,
	getAllModelChoices,
	loadAllConversations,
	type ModelChoice,
	setModelChoice,
} from '$lib/chat/persistence';
import {
	buildDeviceConstraints,
	TAB_MANAGER_SYSTEM_PROMPT,
} from '$lib/chat/system-prompt';
import type { ToolTrustState } from '$lib/state/tool-trust.svelte';
import type { TabManagerBrowser } from '$lib/tab-manager/extension';

export function createAiChatState({
	auth,
	tabManager,
	collaboration,
	toolTrust,
}: {
	auth: AuthClient;
	tabManager: TabManagerBrowser;
	collaboration: Collaboration;
	toolTrust: ToolTrustState;
}) {
	// The inference server's base URL (the swap point, ADR-0049): default the
	// Epicenter gateway; the engine appends `/chat/completions`.
	const inferenceBaseUrl = API_ROUTES.ai.completions.baseUrl(APP_URLS.API);

	// One catalog for every conversation: tab-manager's own browser actions,
	// resolved in-process through `invokeAction` with no relay. Peers (other
	// signed-in devices) advertise their actions too; a local action shadows a
	// remote one of the same name.
	const toolCatalog = createDispatchToolCatalog(collaboration, {
		localActions: tabManager.actions,
		selfNodeId: tabManager.nodeId,
	});

	// ── Model choices (write-through mirror of the settings store) ────
	// Handle getters are synchronous, so the async settings rows hydrate
	// into this map once at startup and every set writes through.

	const modelChoices = new SvelteMap<ConversationId, ModelChoice>();

	// ── Handle Registry (the conversation list) ───────────────────────

	/** Per-conversation handle projections used reactively in templates. */
	const handles = new SvelteMap<
		ConversationId,
		ReturnType<typeof createConversationHandle>
	>();

	// ── Conversation Handle Factory ──────────────────────────────────

	/**
	 * Create a self-contained reactive handle for a single conversation.
	 *
	 * Binds a device-local `createConversation` (the one client agent loop) to
	 * Svelte state through `bindAgentConversation`. Domain logic (model choice,
	 * tool approval and trust, derived metadata) is layered on top. The baked-in
	 * `conversationId` means getters and actions always target the right
	 * conversation, even from async callbacks.
	 */
	function createConversationHandle(conversationId: ConversationId) {
		let inputValue = $state('');
		let dismissedError = $state<string | null>(null);

		/** Recency fallback for drafts: no messages exist until first send. */
		const lastActivityFallback = Date.now();

		const modelChoice = $derived(modelChoices.get(conversationId));

		// The tool call the loop is waiting on a decision for, or null. A mutation
		// pauses the loop here (the present human is the gate, ADR-0047); a query,
		// or a tool the user trusted, runs unattended and never lands here.
		let pendingApproval = $state<{
			call: AgentToolCall;
			resolve: (approved: boolean) => void;
		} | null>(null);

		function settleApproval(approved: boolean) {
			const decision = pendingApproval;
			if (!decision) return;
			pendingApproval = null;
			decision.resolve(approved);
		}

		/** Write-through: the reactive mirror now, the settings row async. */
		function rememberModelChoice(choice: ModelChoice) {
			modelChoices.set(conversationId, choice);
			void setModelChoice(conversationId, choice);
		}

		// Message bodies live in extension-local IndexedDB through the loop's store
		// seam (ADR-0051); the live turn streams in component state and only a
		// finished message lands in storage.
		const convo = bindAgentConversation(
			createAgentConversation({
				store: attachConversationStore(conversationId),
				engine: createOpenAiAgentEngine({
					fetch: auth.fetch,
					baseURL: inferenceBaseUrl,
					data: () => ({
						model: modelChoice?.model ?? DEFAULT_MODEL,
						systemPrompts: [
							buildDeviceConstraints(tabManager.nodeId),
							TAB_MANAGER_SYSTEM_PROMPT,
						],
					}),
				}),
				tools: toolCatalog,
				approval: {
					// A tool the user chose to "Always Allow" auto-approves; otherwise a
					// query runs unattended and a mutation asks (ADR-0044).
					decide: (call, definition) =>
						toolTrust.shouldAutoApprove(call.toolName)
							? 'auto'
							: defaultApprovalDecision(call, definition),
					request: (call) =>
						new Promise<boolean>((resolve) => {
							pendingApproval = { call, resolve };
						}),
				},
				generateId,
			}),
		);

		// Map the loop's two-flag liveness onto the status the message list reads.
		const status = $derived.by(() => {
			if (convo.error) return 'error' as const;
			if (convo.isThinking) return 'submitted' as const;
			if (convo.isGenerating) return 'streaming' as const;
			return 'ready' as const;
		});

		return {
			[Symbol.dispose]() {
				// Unblock a pending approval so the awaiting loop unwinds, then abort.
				settleApproval(false);
				convo[Symbol.dispose]();
			},

			// ── Identity ──

			get id() {
				return conversationId;
			},

			// ── Derived metadata (title and recency come from the messages) ──

			get title() {
				const firstUserMessage = convo.messages.find((m) => m.role === 'user');
				const text = firstUserMessage
					? agentMessageText(firstUserMessage).trim()
					: '';
				return text ? text.slice(0, 50) : 'New Chat';
			},

			get updatedAt() {
				return convo.messages.at(-1)?.createdAt ?? lastActivityFallback;
			},

			get lastMessagePreview() {
				const last = convo.messages.at(-1);
				if (!last) return '';
				const text = agentMessageText(last).trim();
				return text.length > 60 ? `${text.slice(0, 60)}…` : text;
			},

			// ── Model choice ──

			get model() {
				return modelChoice?.model ?? DEFAULT_MODEL;
			},
			set model(value: string) {
				rememberModelChoice({ model: value });
			},

			// ── Chat state (from the loop) ──

			get messages() {
				return convo.messages;
			},

			get isLoading() {
				return convo.isGenerating;
			},

			get error() {
				return convo.error;
			},

			get status() {
				return status;
			},

			/** Credits are exhausted (HTTP 402); UI should prompt an upgrade. */
			get isCreditsExhausted() {
				return convo.error?.code === 'InsufficientCredits';
			},

			get isUnauthorized() {
				return convo.error?.code === 'Unauthorized';
			},

			// ── Tool approval ──

			/** The tool call awaiting the user's decision, or null. */
			get pendingApprovalCallId() {
				return pendingApproval?.call.toolCallId ?? null;
			},

			approveToolCall() {
				settleApproval(true);
			},

			denyToolCall() {
				settleApproval(false);
			},

			/** Trust this tool from now on, then approve the pending call. */
			alwaysAllowToolCall() {
				const toolName = pendingApproval?.call.toolName;
				if (toolName) toolTrust.allow(toolName);
				settleApproval(true);
			},

			// ── Ephemeral UI state ──

			get inputValue() {
				return inputValue;
			},
			set inputValue(value: string) {
				inputValue = value;
			},

			get dismissedError() {
				return dismissedError;
			},
			set dismissedError(value: string | null) {
				dismissedError = value;
			},

			// ── Actions ──

			sendMessage(content: string) {
				convo.send(content);
			},

			reload() {
				convo.retry();
			},

			stop() {
				// A turn parked on an approval is awaiting `request`, which only the
				// user settles; unblock it (as a denial) before aborting, the same
				// order dispose uses, so Stop is never inert mid-approval.
				settleApproval(false);
				convo.stop();
			},

			delete() {
				deleteConversation(conversationId);
			},
		};
	}

	// ── Lifecycle ────────────────────────────────────────────────────

	/** Dispose the loop and remove the handle for a conversation. */
	function destroyConversation(id: ConversationId) {
		handles.get(id)?.[Symbol.dispose]();
		handles.delete(id);
	}

	// ── Active Conversation ──────────────────────────────────────────

	let activeConversationId = $state<ConversationId | null>(null);

	// ── Startup hydration ─────────────────────────────────────────────
	// The store knows which conversations exist; mirror it into the handle
	// registry once, activate the most recent, and sweep settings rows
	// orphaned by drafts that died before their first message.

	void (async () => {
		const [stored, choices] = await Promise.all([
			loadAllConversations(),
			getAllModelChoices(),
		]);

		const storedIds = new Set(stored.map(({ id }) => id));
		for (const [id, choice] of choices) {
			if (storedIds.has(id)) modelChoices.set(id, choice);
			else void deleteModelChoice(id);
		}

		const byRecency = [...stored].sort(
			(a, b) => b.lastActivity - a.lastActivity,
		);
		for (const { id } of byRecency) {
			if (!handles.has(id)) {
				handles.set(id, createConversationHandle(id));
			}
		}

		// Only pick the active conversation if the user hasn't already created a
		// draft while this read was in flight; reassigning here would yank the UI
		// away from it.
		if (activeConversationId === null || !handles.has(activeConversationId)) {
			const mostRecent = byRecency[0];
			if (mostRecent) {
				activeConversationId = mostRecent.id;
			} else {
				createConversation();
			}
		}
	})();

	// ── Conversation CRUD ────────────────────────────────────────────

	/**
	 * Open a new draft conversation, carrying the active conversation's model
	 * choice forward. The draft persists nothing until its first message lands.
	 */
	function createConversation(): ConversationId {
		const id = generateConversationId();
		const current =
			activeConversationId === null
				? undefined
				: handles.get(activeConversationId);

		modelChoices.set(id, { model: current?.model ?? DEFAULT_MODEL });
		handles.set(id, createConversationHandle(id));
		activeConversationId = id;
		return id;
	}

	function deleteConversation(conversationId: ConversationId) {
		destroyConversation(conversationId);
		void clearConversation(conversationId);
		modelChoices.delete(conversationId);
		void deleteModelChoice(conversationId);

		if (activeConversationId === conversationId) {
			const next = conversationList[0];
			if (next) {
				activeConversationId = next.id;
			} else {
				createConversation();
			}
		}
	}

	// ── Public API ────────────────────────────────────────────────────

	const conversationList = $derived(
		[...handles.values()].sort((a, b) => b.updatedAt - a.updatedAt),
	);

	return {
		[Symbol.dispose]() {
			for (const id of handles.keys()) {
				destroyConversation(id);
			}
		},

		get active() {
			return activeConversationId === null
				? undefined
				: handles.get(activeConversationId);
		},

		get conversations() {
			return conversationList;
		},

		get activeConversationId() {
			return activeConversationId;
		},

		createConversation,

		switchTo(conversationId: ConversationId) {
			activeConversationId = conversationId;
		},
	};
}

/** A reactive handle for a single conversation backed by the client loop. */
type AiChatState = ReturnType<typeof createAiChatState>;
export type ConversationHandle = NonNullable<AiChatState['active']>;
