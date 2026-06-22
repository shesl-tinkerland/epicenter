<script module lang="ts">
	import { APP_URLS } from '@epicenter/constants/vite';
	import { epicenterMeteredEngine } from '@epicenter/vocab/engine';
	import { auth } from '$platform/auth';

	// The client answers over the metered `/api/ai/chat` SSE stream (ADR-0043).
	// One engine, built once and shared across every mounted conversation view.
	const clientEngine = epicenterMeteredEngine(auth.fetch, APP_URLS.API);
</script>

<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as Chat from '@epicenter/ui/chat';
	import { InstantString } from '@epicenter/workspace';
	import type { ConversationId } from '@epicenter/vocab';
	import { onDestroy } from 'svelte';
	import { createConversation } from '$lib/conversation.svelte';
	import { requireVocab } from '$lib/session';
	import ChatInput from './ChatInput.svelte';
	import ChatMessage from './ChatMessage.svelte';

	let {
		conversationId,
		showPinyin,
	}: { conversationId: ConversationId; showPinyin: boolean } = $props();

	const vocab = requireVocab();

	// The component is keyed on conversationId, so it mounts fresh per
	// conversation: open the message store and bind it to the inference engine.
	// The controller owns streaming, persistence, and the render state; dispose
	// on unmount.
	// svelte-ignore state_referenced_locally
	const convo = createConversation(
		vocab.tables.conversations.docs.messages.open(conversationId),
		clientEngine,
	);

	onDestroy(() => convo[Symbol.dispose]());

	let dismissedError = $state(false);
	let inputValue = $state('');

	const error = $derived(convo.error);

	/**
	 * A send persists the user turn and starts the answer. The controller streams
	 * the reply into component state and writes the finished message to the store.
	 */
	function sendMessage(content: string) {
		const text = content.trim();
		if (!text || convo.isGenerating) return;
		dismissedError = false;
		convo.send(text);
		const title = vocab.tables.conversations.get(conversationId).data?.title;
		vocab.tables.conversations.update(conversationId, {
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
	{#if convo.messages.length === 0}
		<div class="flex flex-1 items-center justify-center text-muted-foreground">
			<p>Ask a question in English and get a response in Chinese and English.</p>
		</div>
	{:else}
		{#each convo.messages as message (message.id)}
			<ChatMessage {message} {showPinyin} />
		{/each}
	{/if}

	{#if convo.isThinking}
		<Chat.Bubble variant="received">
			<Chat.BubbleMessage typing />
		</Chat.Bubble>
	{/if}

	{#if error && !dismissedError}
		<div
			class="flex items-center gap-2 rounded-md bg-destructive/10 p-3 text-sm text-destructive"
		>
			<span class="flex-1">{error.message}</span>
			<Button size="sm" variant="outline" onclick={retry}>Retry</Button>
			<Button size="sm" variant="ghost" onclick={() => (dismissedError = true)}>
				✕
			</Button>
		</div>
	{/if}
</Chat.List>

<ChatInput
	bind:value={inputValue}
	isGenerating={convo.isGenerating}
	onSend={sendMessage}
	onStop={() => convo.stop()}
/>
