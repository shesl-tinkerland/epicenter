<script module lang="ts">
	import { APP_URLS } from '@epicenter/constants/vite';
	import type { Engine } from '@epicenter/zhongwen';
	import { epicenterMeteredEngine } from '@epicenter/zhongwen/engine';
	import { auth } from '$platform/auth';

	// The engines this tab can power, highest priority first. Today just the
	// metered Epicenter account over the `/api/ai/chat` SSE stream; adding a
	// local-key engine ahead of it is the whole of "engine unification" (the same
	// list the daemon walks). Built once, shared across every mounted view.
	const browserEngines: readonly Engine[] = [
		epicenterMeteredEngine(auth.fetch, APP_URLS.API),
	];
</script>

<script lang="ts">
	import { bindConversation } from '@epicenter/svelte';
	import { Button } from '@epicenter/ui/button';
	import * as Chat from '@epicenter/ui/chat';
	import { InstantString } from '@epicenter/workspace';
	import {
		agentConfig,
		type ConversationId,
		resolveEngine,
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

	// Who answers this conversation? Two orthogonal questions (ADR-0033). First,
	// designation: does this tab write the turn? A tab answers only the agents it
	// owns (an `'ephemeral'` owner); a `'durable'` owner is a resident daemon that
	// answers ambiently over sync, so the tab stays out (answering too would answer
	// one turn twice). The bound agent is immutable, so this never flips
	// mid-conversation. Then engine: which backend powers the answer
	// (`resolveEngine`, ADR-0038). ADR-0033: a conversation is a synced doc only an
	// in-process peer writes.
	// svelte-ignore state_referenced_locally
	const boundAgent = readRow()?.agent;
	const answersHere =
		boundAgent !== undefined && agentConfig(boundAgent)?.owner === 'ephemeral';
	const answer = answersHere
		? (resolveEngine(browserEngines) ?? undefined)
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
