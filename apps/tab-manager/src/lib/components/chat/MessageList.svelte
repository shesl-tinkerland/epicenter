<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as Chat from '@epicenter/ui/chat';
	import * as Empty from '@epicenter/ui/empty';
	import RotateCcwIcon from '@lucide/svelte/icons/rotate-ccw';
	import SparklesIcon from '@lucide/svelte/icons/sparkles';
	import type { AgentMessage } from '@epicenter/workspace/agent';
	import MessageParts from './MessageParts.svelte';

	let {
		messages,
		status,
		onReload,
		pendingApprovalCallId,
		onApproveToolCall,
		onDenyToolCall,
		onAlwaysAllowToolCall,
	}: {
		messages: AgentMessage[];
		status: 'ready' | 'submitted' | 'streaming' | 'error';
		onReload: () => void;
		/** The tool call awaiting a decision, or null. */
		pendingApprovalCallId: string | null;
		onApproveToolCall: () => void;
		onDenyToolCall: () => void;
		onAlwaysAllowToolCall: () => void;
	} = $props();

	/**
	 * Show loading dots when waiting for assistant content: 'submitted'
	 * before the first token, or 'streaming' before any assistant message
	 * appears. The tool-result-to-continuation handoff needs no case here:
	 * the loop starts the continuation in the same microtask chain that
	 * settles the tool, so 'ready' with a trailing tool-result never paints
	 * mid-flow. It does occur durably (a run that stopped after a tool), and
	 * then the honest UI is the Regenerate affordance, not typing dots.
	 */
	const showLoadingDots = $derived(
		status === 'submitted' ||
			(status === 'streaming' && messages.at(-1)?.role !== 'assistant'),
	);

	/** Show regenerate button when idle and last message is from assistant. */
	const showRegenerate = $derived(
		status === 'ready' && messages.at(-1)?.role === 'assistant',
	);
</script>

{#if messages.length === 0}
	<Empty.Root class="py-12">
		<Empty.Media>
			<SparklesIcon class="size-8 text-muted-foreground" />
		</Empty.Media>
		<Empty.Title>AI Chat</Empty.Title>
		<Empty.Description>Send a message to start chatting</Empty.Description>
	</Empty.Root>
{:else}
	<Chat.List>
		{#each messages as message (message.id)}
			<Chat.Bubble variant={message.role === 'user' ? 'sent' : 'received'}>
				<Chat.BubbleMessage>
					<MessageParts
						parts={message.parts}
						{pendingApprovalCallId}
						{onApproveToolCall}
						{onDenyToolCall}
						{onAlwaysAllowToolCall}
					/>
				</Chat.BubbleMessage>
			</Chat.Bubble>
		{/each}
		{#if showLoadingDots}
			<Chat.Bubble variant="received">
				<Chat.BubbleMessage typing />
			</Chat.Bubble>
		{/if}
		{#if showRegenerate}
			<div class="flex justify-start px-2 py-1">
				<Button
					variant="ghost"
					class="text-muted-foreground"
					onclick={onReload}
				>
					<RotateCcwIcon class="size-3" />
					Regenerate
				</Button>
			</div>
		{/if}
	</Chat.List>
{/if}
