import type { AuthClient } from '@epicenter/auth';
import { AiChatHttpError } from '@epicenter/constants/ai-chat-errors';
import { APP_URLS } from '@epicenter/constants/vite';
import { createAiChatFetch, fromTable } from '@epicenter/svelte';
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
import type { JsonValue } from 'wellcrafted/json';
import {
	DEFAULT_MODEL,
	DEFAULT_PROVIDER,
	PROVIDER_MODELS,
	type Provider,
} from '$lib/chat/providers';
import {
	buildGlobalSkillsPrompt,
	buildVaultSkillsPrompt,
	OPENSIDIAN_SYSTEM_PROMPT,
} from '$lib/chat/system-prompt';
import { toUiMessage } from '$lib/chat/ui-message';
import { searchParams } from '$lib/search-params.svelte';
import type { SkillState } from '$lib/state/skill-state.svelte';

function getStringValue(value: JsonValue | undefined, fallback: string) {
	return typeof value === 'string' ? value : fallback;
}

function getNumberValue(value: JsonValue | undefined, fallback = 0) {
	return typeof value === 'number' ? value : fallback;
}

function getProviderValue(value: JsonValue | undefined): Provider {
	return typeof value === 'string' && value in PROVIDER_MODELS
		? (value as Provider)
		: DEFAULT_PROVIDER;
}

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
		[...conversationsMap.values()].sort(
			(a, b) => getNumberValue(b.updatedAt) - getNumberValue(a.updatedAt),
		),
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
			provider: DEFAULT_PROVIDER,
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
			.filter((message) => message.conversationId === conversationId)
			.sort((a, b) => a.createdAt - b.createdAt)
			.map(toUiMessage);
	}

	const handles = new Map<
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
							provider: metadata?.provider ?? DEFAULT_PROVIDER,
							model: metadata?.model ?? DEFAULT_MODEL,
							conversationId,
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
					parts: message.parts as JsonValue[],
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
			[Symbol.dispose]() {
				chat.stop();
			},

			get id() {
				return conversationId;
			},

			get title() {
				return getStringValue(metadata?.title, 'New Chat');
			},

			get provider() {
				return getProviderValue(metadata?.provider);
			},
			set provider(value: Provider) {
				const models = PROVIDER_MODELS[value];
				updateConversation(conversationId, {
					provider: value,
					model: models[0] ?? DEFAULT_MODEL,
				});
			},

			get model() {
				return getStringValue(metadata?.model, DEFAULT_MODEL);
			},
			set model(value: string) {
				updateConversation(conversationId, { model: value });
			},

			get createdAt() {
				return getNumberValue(metadata?.createdAt);
			},

			get updatedAt() {
				return getNumberValue(metadata?.updatedAt);
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
					parts: [{ type: 'text', content }],
					createdAt: Date.now(),
				});

				const currentTitle = getStringValue(metadata?.title, 'New Chat');

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
			provider: active?.provider ?? DEFAULT_PROVIDER,
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

		get provider() {
			return handles.get(activeConversationId)?.provider ?? DEFAULT_PROVIDER;
		},
		set provider(value: Provider) {
			const active = handles.get(activeConversationId);
			if (!active) return;
			active.provider = value;
		},

		get model() {
			return handles.get(activeConversationId)?.model ?? DEFAULT_MODEL;
		},
		set model(value: string) {
			const active = handles.get(activeConversationId);
			if (!active) return;
			active.model = value;
		},

		modelsForProvider(providerName: string): readonly string[] {
			return PROVIDER_MODELS[providerName as Provider] ?? [];
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
