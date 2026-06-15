<script lang="ts">
	import * as Chat from '@epicenter/ui/chat';
	import type { ChatDocMessage } from '@epicenter/workspace/ai';
	import type { Vocabulary } from '@epicenter/zhongwen';
	import AssistantMessagePart from './AssistantMessagePart.svelte';

	type Props = {
		message: ChatDocMessage;
		showPinyin: boolean;
		highlightVocab: boolean;
		words: Vocabulary[];
	};

	let { message, showPinyin, highlightVocab, words }: Props = $props();

	const isUser = $derived(message.role === 'user');
</script>

<!-- data-message-id lets a tapped word or a selection resolve its sentence from
	the live messages array (no message text duplicated into the DOM). -->
<Chat.Bubble variant={isUser ? 'sent' : 'received'} data-message-id={message.id}>
	<Chat.BubbleMessage>
		<!-- Text-only by design: zhongwen chat docs carry a single Y.Text per
			message; there are no tool or media parts to dispatch on. -->
		{#if isUser}
			{message.text}
		{:else}
			<AssistantMessagePart
				content={message.text}
				{showPinyin}
				{highlightVocab}
				{words}
			/>
		{/if}
	</Chat.BubbleMessage>
</Chat.Bubble>
{#if message.finish?.kind === 'cancelled'}
	<p class="pl-2 pt-1 text-xs text-muted-foreground">Stopped</p>
{/if}
