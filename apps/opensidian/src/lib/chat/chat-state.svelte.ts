import type { AuthClient } from '@epicenter/auth';
import { createAiChatFetch } from '@epicenter/client';
import { AiChatHttpError } from '@epicenter/constants/ai-chat-errors';
import { APP_URLS } from '@epicenter/constants/vite';
import { fromTable } from '@epicenter/svelte';
import { actionsToAiTools } from '@epicenter/workspace/ai';
import { createChat, fetchServerSentEvents } from '@tanstack/ai-svelte';
import {
	asChatMessageId,
	asConversationId,
	type Conversation,
	type ConversationId,
	generateChatMessageId,
	generateConversationId,
} from 'opensidian';
import type { OpensidianBrowser } from 'opensidian/browser';
import { SvelteMap } from 'svelte/reactivity';
import { DEFAULT_MODEL } from '$lib/chat/models';
import {
	buildGlobalSkillsPrompt,
	buildVaultSkillsPrompt,
	OPENSIDIAN_SYSTEM_PROMPT,
} from '$lib/chat/system-prompt';
import { toPersistedParts, toUiMessage } from '$lib/chat/ui-message';
import { searchParams } from '$lib/search-params.svelte';
import type { SkillState } from '$lib/state/skill-state.svelte';

type SessionAiTools = ReturnType<
	typeof actionsToAiTools<OpensidianBrowser['collaboration']['actions']>
>;
export type SessionTools = SessionAiTools['tools'];

export function createAiChatState({
	auth,
	workspace,
	skills,
}: {
	auth: AuthClient;
	workspace: OpensidianBrowser;
	skills: SkillState;
}) {
	const sessionAiTools = actionsToAiTools(workspace.collaboration.actions);
	const conversationsMap = fromTable(workspace.tables.conversations);
	const conversations = $derived(
		[...conversationsMap.values()].sort((a, b) => b.updatedAt - a.updatedAt),
	);

	function ensureDefaultConversation(): ConversationId | undefined {
		if (conversations.length > 0) return undefined;

		const id = generateConversationId();
		const now = Date.now();

		workspace.tables.conversations.set({
			id,
			title: 'New Chat',
			parentId: null,
			sourceMessageId: null,
			systemPrompt: null,
			model: DEFAULT_MODEL,
			createdAt: now,
			updatedAt: now,
		});

		return id;
	}

	function updateConversation(
		conversationId: ConversationId,
		patch: Partial<Omit<Conversation, 'id'>>,
	) {
		workspace.tables.conversations.update(conversationId, {
			...patch,
			updatedAt: Date.now(),
		});
	}

	function loadMessages(conversationId: ConversationId) {
		return workspace.tables.chatMessages
			.scan()
			.rows.filter((message) => message.conversationId === conversationId)
			.sort((a, b) => a.createdAt - b.createdAt)
			.map(toUiMessage);
	}

	const handles = new SvelteMap<
		ConversationId,
		ReturnType<typeof createConversationHandle>
	>();

	function createConversationHandle(conversationId: ConversationId) {
		const metadata = $derived(conversationsMap.get(conversationId));

		const chat = createChat({
			initialMessages: loadMessages(conversationId),
			tools: sessionAiTools.tools,
			connection: fetchServerSentEvents(
				`${APP_URLS.API}/ai/chat`,
				async () => ({
					fetchClient: createAiChatFetch(auth.fetch),
					body: {
						data: {
							model: metadata?.model ?? DEFAULT_MODEL,
							systemPrompts: [
								OPENSIDIAN_SYSTEM_PROMPT,
								buildGlobalSkillsPrompt(
									skills.globalSkills.map((skill) => ({
										name: skill.name,
										instructions: skill.instructions,
									})),
								),
								buildVaultSkillsPrompt(
									skills.vaultSkills.map((skill) => ({
										name: skill.name,
										content: skill.content,
									})),
								),
							].filter(Boolean),
							tools: sessionAiTools.definitions,
						},
					},
				}),
			),
			onFinish: (message) => {
				workspace.tables.chatMessages.set({
					id: asChatMessageId(message.id),
					conversationId,
					role: 'assistant',
					parts: toPersistedParts(message.parts),
					createdAt: message.createdAt?.getTime() ?? Date.now(),
				});

				updateConversation(conversationId, {});
			},
			onError: (error) => {
				console.error(
					'[opensidian-ai-chat] stream error:',
					error.message,
					'conversation:',
					conversationId,
				);
			},
		});

		return {
			// Abort any in-flight stream, then release the devtools bridge,
			// which holds the client in a globalThis registry that would
			// otherwise outlive the handle.
			[Symbol.dispose]() {
				chat.stop();
				chat.dispose();
			},

			get id() {
				return conversationId;
			},

			get title() {
				return metadata?.title ?? 'New Chat';
			},

			get model() {
				return metadata?.model ?? DEFAULT_MODEL;
			},
			set model(value: string) {
				updateConversation(conversationId, { model: value });
			},

			get createdAt() {
				return metadata?.createdAt ?? 0;
			},

			get updatedAt() {
				return metadata?.updatedAt ?? 0;
			},

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

			sendMessage(content: string) {
				if (!content.trim()) return;

				const userMessageId = generateChatMessageId();

				void chat.sendMessage({
					content,
					id: userMessageId,
				});

				workspace.tables.chatMessages.set({
					id: userMessageId,
					conversationId,
					role: 'user',
					parts: toPersistedParts([{ type: 'text', content }]),
					createdAt: Date.now(),
				});

				const currentTitle = metadata?.title ?? 'New Chat';

				updateConversation(conversationId, {
					title:
						currentTitle === 'New Chat'
							? content.trim().slice(0, 50)
							: currentTitle,
				});
			},

			reload() {
				const lastMessage = chat.messages.at(-1);
				if (lastMessage?.role === 'assistant') {
					workspace.tables.chatMessages.delete(asChatMessageId(lastMessage.id));
				}

				void chat.reload();
			},

			stop() {
				chat.stop();
			},

			approveToolCall(approvalId: string) {
				void chat.addToolApprovalResponse({ id: approvalId, approved: true });
			},

			denyToolCall(approvalId: string) {
				void chat.addToolApprovalResponse({ id: approvalId, approved: false });
			},

			refreshMessages() {
				if (chat.isLoading) return;
				chat.setMessages(loadMessages(conversationId));
			},
		};
	}

	function destroyConversation(conversationId: ConversationId) {
		handles.get(conversationId)?.[Symbol.dispose]();
		handles.delete(conversationId);
	}

	function reconcileHandles() {
		for (const conversationId of handles.keys()) {
			if (!conversationsMap.has(conversationId as string)) {
				destroyConversation(conversationId);
			}
		}

		for (const conversationId of conversationsMap.keys()) {
			const id = asConversationId(conversationId);
			if (!handles.has(id)) {
				handles.set(id, createConversationHandle(id));
			}
		}

		const firstConversation = conversations[0];
		if (!firstConversation) return;
		if (handles.has(activeConversationId)) return;

		const newActiveId = asConversationId(firstConversation.id);
		searchParams.update({ chat: newActiveId });
		handles.get(newActiveId)?.refreshMessages();
	}

	const activeConversationId = $derived(
		asConversationId(searchParams.chat ?? ''),
	);

	const _unobserveConversations = workspace.tables.conversations.observe(() => {
		reconcileHandles();
	});
	const _unobserveChatMessages = workspace.tables.chatMessages.observe(() => {
		handles.get(activeConversationId)?.refreshMessages();
	});

	void workspace.idb.whenLoaded.then(() => {
		void skills.loadAllSkills();
		reconcileHandles();

		const newId = ensureDefaultConversation();
		if (newId) {
			searchParams.update({ chat: newId });
			handles.get(newId)?.refreshMessages();
			return;
		}

		const firstConversation = conversations[0];
		if (!firstConversation) return;

		const activeId = asConversationId(firstConversation.id);
		searchParams.update({ chat: activeId });
		handles.get(activeId)?.refreshMessages();
	});

	reconcileHandles();

	function newConversation() {
		const id = generateConversationId();
		const now = Date.now();
		const active = handles.get(activeConversationId);

		workspace.tables.conversations.set({
			id,
			title: 'New Chat',
			parentId: null,
			sourceMessageId: null,
			systemPrompt: null,
			model: active?.model ?? DEFAULT_MODEL,
			createdAt: now,
			updatedAt: now,
		});

		searchParams.update({ chat: id });
		handles.get(id)?.refreshMessages();

		return id;
	}

	return {
		[Symbol.dispose]() {
			_unobserveConversations();
			_unobserveChatMessages();
			conversationsMap[Symbol.dispose]();
			for (const conversationId of [...handles.keys()]) {
				destroyConversation(conversationId);
			}
		},

		get active() {
			return handles.get(activeConversationId);
		},

		get isLoading() {
			return handles.get(activeConversationId)?.isLoading ?? false;
		},

		get model() {
			return handles.get(activeConversationId)?.model ?? DEFAULT_MODEL;
		},
		set model(value: string) {
			const active = handles.get(activeConversationId);
			if (!active) return;
			active.model = value;
		},

		sendMessage(content: string) {
			handles.get(activeConversationId)?.sendMessage(content);
		},

		stop() {
			handles.get(activeConversationId)?.stop();
		},

		newConversation,
	};
}
