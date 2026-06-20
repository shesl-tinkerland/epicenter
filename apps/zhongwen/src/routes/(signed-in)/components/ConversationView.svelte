<script module lang="ts">
	import { createAiChatFetch } from '@epicenter/client';
	import { auth } from '$platform/auth';

	// auth is a module singleton, so the wrapped fetch is built once and shared
	// across every mounted ConversationView.
	const aiChatFetch = createAiChatFetch(auth.fetch);
</script>

<script lang="ts">
	import { createEpicenterProviderChatStream } from '@epicenter/client';
	import { API_ROUTES } from '@epicenter/constants/api-routes';
	import { APP_URLS } from '@epicenter/constants/vite';
	import { bindConversation } from '@epicenter/svelte';
	import { Button } from '@epicenter/ui/button';
	import * as Chat from '@epicenter/ui/chat';
	import { InstantString } from '@epicenter/workspace';
	import {
		agentConfig,
		type ConversationId,
		ZHONGWEN_MODEL,
		ZHONGWEN_SYSTEM_PROMPT,
	} from '@epicenter/zhongwen';
	import { onDestroy } from 'svelte';
	import { requireZhongwen } from '$lib/session';
	import ChatInput from './ChatInput.svelte';
	import ChatMessage from './ChatMessage.svelte';

	let {
		conversationId,
		showPinyin,
	}: { conversationId: ConversationId; showPinyin: boolean } = $props();

	const zhongwen = requireZhongwen();

	// The durable conversation row (title, bound agent) is read at action time,
	// never in the template, so a plain read suffices.
	function readRow() {
		return zhongwen.tables.conversations.get(conversationId).data;
	}

	// Who answers this conversation? A daemon-runtime agent is a resident listener
	// that answers ambiently over sync, so the browser stays out (answering too
	// would double-answer one turn). Any other binding (the cloud agent) is
	// answered in-process: the browser runs the same answerer the daemon does,
	// sourcing tokens from the Epicenter provider (the metered /api/ai/chat SSE
	// stream). The bound agent is immutable, so this never flips mid-conversation.
	// ADR-0033: a conversation is a synced doc only an in-process peer writes.
	// svelte-ignore state_referenced_locally
	const boundAgent = readRow()?.agent;
	const answer =
		boundAgent !== undefined && agentConfig(boundAgent)?.runtime !== 'daemon'
			? createEpicenterProviderChatStream({
					fetch: aiChatFetch,
					url: API_ROUTES.ai.chat.url(APP_URLS.API),
					data: () => ({
						model: ZHONGWEN_MODEL,
						systemPrompts: [ZHONGWEN_SYSTEM_PROMPT],
					}),
				})
			: undefined;

	// The component is keyed on conversationId, so it mounts fresh per
	// conversation: open the transcript doc and bind it (the answerer, the clock,
	// and the render projection live in the handle + shim), dispose on unmount.
	// svelte-ignore state_referenced_locally
	const convo = bindConversation(
		zhongwen.tables.conversations.docs.messages.open(conversationId),
		{ answer },
	);

	onDestroy(() => convo[Symbol.dispose]());

	let dismissedError = $state(false);
	let inputValue = $state('');

	const error = $derived(convo.render.failure?.message ?? null);

	/**
	 * A send is one durable transcript write: `convo.send` mints the user turn's
	 * id and the `generationId` the answer awaits. The in-process answerer (or a
	 * bound daemon) observes the write and claims the turn. There is no kickoff
	 * and no second message table to reconcile.
	 */
	function sendMessage(content: string) {
		const text = content.trim();
		if (!text || convo.render.isGenerating) return;
		dismissedError = false;
		convo.send(text);
		const title = readRow()?.title;
		zhongwen.tables.conversations.update(conversationId, {
			title: title === 'New Chat' ? text.slice(0, 50) : title,
			updatedAt: InstantString.now(),
		});
	}

	function retry() {
		dismissedError = false;
		convo.retry();
	}
</script>

<Chat.List class="flex-1 overflow-y-auto p-4" aria-live="polite">
	{#if convo.render.visibleMessages.length === 0}
		<div class="flex flex-1 items-center justify-center text-muted-foreground">
			<p>Ask a question in English and get a response in Chinese and English.</p>
		</div>
	{:else}
		<!-- visibleMessages drops the empty assistant placeholder of an in-progress
			turn; the typing bubble below stands in for it. -->
		{#each convo.render.visibleMessages as message (message.id)}
			<ChatMessage {message} {showPinyin} />
		{/each}
	{/if}

	{#if convo.render.isThinking}
		<Chat.Bubble variant="received">
			<Chat.BubbleMessage typing />
		</Chat.Bubble>
	{/if}

	{#if error && !dismissedError}
		<div
			class="flex items-center gap-2 rounded-md bg-destructive/10 p-3 text-sm text-destructive"
		>
			<span class="flex-1">{error}</span>
			<Button size="sm" variant="outline" onclick={retry}>Retry</Button>
			<Button size="sm" variant="ghost" onclick={() => (dismissedError = true)}>
				✕
			</Button>
		</div>
	{:else if convo.render.isInterrupted}
		<div
			class="flex items-center gap-2 rounded-md bg-muted p-3 text-sm text-muted-foreground"
		>
			<span class="flex-1">This reply was interrupted.</span>
			<Button size="sm" variant="outline" onclick={retry}>Retry</Button>
		</div>
	{/if}
</Chat.List>

<ChatInput
	bind:value={inputValue}
	isGenerating={convo.render.isGenerating}
	onSend={sendMessage}
	onStop={() => convo.stop()}
/>
