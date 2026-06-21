<script lang="ts">
	import * as Chat from '@epicenter/ui/chat';
	import type { ChatDocMessage } from '@epicenter/workspace/ai';
	import AssistantMessagePart from './AssistantMessagePart.svelte';

	type Props = {
		message: ChatDocMessage;
		showPinyin: boolean;
	};

	let { message, showPinyin }: Props = $props();

	const isUser = $derived(message.role === 'user');
</script>

<Chat.Bubble variant={isUser ? 'sent' : 'received'}>
	<Chat.BubbleMessage>
		<!-- Text-only by design: vocab chat docs carry a single Y.Text per
			message; there are no tool or media parts to dispatch on. -->
		{#if isUser}
			{message.text}
		{:else}
			<AssistantMessagePart content={message.text} {showPinyin} />
		{/if}
	</Chat.BubbleMessage>
</Chat.Bubble>
{#if message.finish?.kind === 'cancelled'}
	<p class="pl-2 pt-1 text-xs text-muted-foreground">Stopped</p>
{/if}
