<script lang="ts">
	import * as Chat from '@epicenter/ui/chat';
	import type { VocabMessage } from '@epicenter/vocab';
	import { agentMessageText } from '@epicenter/workspace/agent';
	import AssistantMessagePart from './AssistantMessagePart.svelte';

	let {
		message,
		showPinyin,
	}: { message: VocabMessage; showPinyin: boolean } = $props();

	const isUser = $derived(message.role === 'user');
	// Vocab is capability-free, so a message is plain prose: its text parts.
	const text = $derived(agentMessageText(message));
</script>

<Chat.Bubble variant={isUser ? 'sent' : 'received'}>
	<Chat.BubbleMessage>
		{#if isUser}
			{text}
		{:else}
			<AssistantMessagePart content={text} {showPinyin} />
		{/if}
	</Chat.BubbleMessage>
</Chat.Bubble>
