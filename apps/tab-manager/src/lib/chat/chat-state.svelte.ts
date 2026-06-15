/**
 * Reactive AI chat state with multi-conversation support.
 *
 * Architecture: self-contained ConversationHandles backed by `createChat`.
 *
 * Chat is fully device-local. The handle registry is the conversation
 * list: it hydrates once from the IndexedDB chat store at startup, and
 * from then on creates and deletes go through the registry, with message
 * bodies lazily persisted by the chat client's persistence adapter (see
 * ./persistence.ts). A new conversation is an in-memory draft until its
 * first message lands, so empty chats are never stored. Titles and
 * recency derive from the messages themselves; the only stored metadata
 * is the per-conversation model pick.
 *
 * Background streaming is free: each conversation has its own chat
 * instance. Switching away from a streaming conversation doesn't stop it.
 *
 * Components read this through `workspace.state.aiChat`.
 */

import type { AuthClient } from '@epicenter/auth';
import { createAiChatFetch } from '@epicenter/client';
import { AiChatHttpError } from '@epicenter/constants/ai-chat-errors';
import { APP_URLS } from '@epicenter/constants/vite';
import { createChat, fetchServerSentEvents } from '@tanstack/ai-svelte';
import { SvelteMap } from 'svelte/reactivity';
import { DEFAULT_MODEL } from '$lib/chat/models';
import {
	asConversationId,
	type ConversationId,
	chatPersistence,
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
import type { SessionAiTools } from '$lib/session.svelte';
import type { TabManagerBrowser } from '$lib/tab-manager/extension';

export function createAiChatState({
	auth,
	tabManager,
	sessionAiTools,
}: {
	auth: AuthClient;
	tabManager: TabManagerBrowser;
	sessionAiTools: SessionAiTools;
}) {
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
	 * Uses `createChat` from `@tanstack/ai-svelte` for reactive state
	 * management and message persistence. Domain logic (model choice,
	 * tool approval, derived metadata) is layered on top.
	 *
	 * The baked-in `conversationId` means getters and actions always target
	 * the correct conversation, even from async callbacks.
	 */
	function createConversationHandle(conversationId: ConversationId) {
		let inputValue = $state('');
		let dismissedError = $state<string | null>(null);

		/** Recency fallback for drafts: no messages exist until first send. */
		const lastActivityFallback = Date.now();

		const modelChoice = $derived(modelChoices.get(conversationId));

		/** Write-through: the reactive mirror now, the settings row async. */
		function rememberModelChoice(choice: ModelChoice) {
			modelChoices.set(conversationId, choice);
			void setModelChoice(conversationId, choice);
		}

		// Message bodies live in extension-local IndexedDB through the
		// persistence adapter, hydrated by conversation id; see
		// ./persistence.ts for why they left the Y.Doc. The client owns the
		// whole write path: sends, streamed chunks, and reload truncation all
		// land in storage through its ordered setItem queue.
		const chat = createChat({
			id: conversationId,
			persistence: chatPersistence,
			tools: sessionAiTools.tools,
			connection: fetchServerSentEvents(`${APP_URLS.API}/ai/chat`, async () => {
				const deviceId = tabManager.deviceId;
				return {
					fetchClient: createAiChatFetch(auth.fetch),
					body: {
						data: {
							model: modelChoice?.model ?? DEFAULT_MODEL,
							systemPrompts: [
								buildDeviceConstraints(deviceId),
								TAB_MANAGER_SYSTEM_PROMPT,
							],
							tools: sessionAiTools.definitions,
						},
					},
				};
			}),
			onError: (err) => {
				console.error(
					'[ai-chat] stream error:',
					err.message,
					'conversation:',
					conversationId,
				);
			},
		});

		return {
			// ── Identity ──

			get id() {
				return conversationId;
			},

			// ── Derived metadata (title and recency come from the messages) ──

			get title() {
				const firstUserMessage = chat.messages.find((m) => m.role === 'user');
				const text = firstUserMessage?.parts
					.filter((p) => p.type === 'text')
					.map((p) => p.content)
					.join('')
					.trim();
				return text ? text.slice(0, 50) : 'New Chat';
			},

			get updatedAt() {
				return (
					chat.messages.at(-1)?.createdAt?.getTime() ?? lastActivityFallback
				);
			},

			// ── Model choice ──

			get model() {
				return modelChoice?.model ?? DEFAULT_MODEL;
			},
			set model(value: string) {
				rememberModelChoice({ model: value });
			},

			// ── Chat state (from createChat) ──

			get messages() {
				return chat.messages;
			},

			get isLoading() {
				return chat.isLoading;
			},

			get error() {
				return chat.error;
			},

			get status() {
				return chat.status;
			},

			/**
			 * Whether the last error was a 402 (credits exhausted).
			 * UI should show an upgrade prompt when true.
			 */
			get isCreditsExhausted() {
				return (
					chat.error instanceof AiChatHttpError &&
					chat.error.detail.name === 'InsufficientCredits'
				);
			},

			get isUnauthorized() {
				return (
					chat.error instanceof AiChatHttpError &&
					chat.error.detail.name === 'Unauthorized'
				);
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

			// ── Derived convenience ──

			get lastMessagePreview() {
				const last = chat.messages.at(-1);
				if (!last) return '';
				const text = last.parts
					.filter((p) => p.type === 'text')
					.map((p) => p.content)
					.join('')
					.trim();
				return text.length > 60 ? `${text.slice(0, 60)}…` : text;
			},

			// ── Actions ──

			sendMessage(content: string) {
				void chat.sendMessage(content);
			},

			reload() {
				// The client truncates past the last user message and the
				// persistence adapter stores the truncated list.
				void chat.reload();
			},

			stop() {
				chat.stop();
			},

			/**
			 * Tear down the chat client: abort any in-flight stream, then
			 * release the devtools bridge, which holds the client in a
			 * globalThis registry that would otherwise outlive the handle.
			 */
			dispose() {
				chat.stop();
				chat.dispose();
			},

			/**
			 * Delete this conversation's stored history through the client's
			 * ordered persistence queue (`clear` invalidates queued writes),
			 * so a mid-stream setItem can't land after the delete and
			 * resurrect history the user asked to remove. Calling the
			 * adapter's removeItem directly would race that queue.
			 */
			clearHistory() {
				chat.clear();
			},

			approveToolCall(approvalId: string) {
				void chat.addToolApprovalResponse({ id: approvalId, approved: true });
			},

			denyToolCall(approvalId: string) {
				void chat.addToolApprovalResponse({ id: approvalId, approved: false });
			},

			delete() {
				deleteConversation(conversationId);
			},
		};
	}

	// ── Lifecycle ────────────────────────────────────────────────────

	/** Dispose the chat client and remove the handle for a conversation. */
	function destroyConversation(id: ConversationId) {
		handles.get(id)?.dispose();
		handles.delete(id);
	}

	// ── Active Conversation ──────────────────────────────────────────

	let activeConversationId = $state<ConversationId>(asConversationId(''));

	// ── Startup hydration ─────────────────────────────────────────────
	// The store knows which conversations exist; mirror it into the handle
	// registry once, activate the most recent, and sweep settings rows
	// orphaned by drafts that died before their first message. Each
	// handle's chat hydrates its own messages through the adapter; the
	// bulk read here only discovers ids and recency.

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

		const byRecency = stored
			.map(({ id, messages }) => ({
				id,
				lastActivity: messages.at(-1)?.createdAt?.getTime() ?? 0,
			}))
			.sort((a, b) => b.lastActivity - a.lastActivity);
		for (const { id } of byRecency) {
			if (!handles.has(id)) {
				handles.set(id, createConversationHandle(id));
			}
		}

		// Only pick the active conversation if the user hasn't already
		// created a draft while this read was in flight; reassigning here
		// would yank the UI away from it.
		if (!handles.has(activeConversationId)) {
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
	 * Open a new draft conversation, carrying the active conversation's
	 * model choice forward. The draft persists nothing until its first
	 * message lands through the adapter.
	 */
	function createConversation(): ConversationId {
		const id = generateConversationId();
		const current = handles.get(activeConversationId);

		modelChoices.set(id, { model: current?.model ?? DEFAULT_MODEL });
		handles.set(id, createConversationHandle(id));
		activeConversationId = id;
		return id;
	}

	function deleteConversation(conversationId: ConversationId) {
		handles.get(conversationId)?.clearHistory();
		destroyConversation(conversationId);
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
			return handles.get(activeConversationId);
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

/** A reactive handle for a single conversation backed by `createChat`. */
type AiChatState = ReturnType<typeof createAiChatState>;
export type ConversationHandle = NonNullable<AiChatState['active']>;
