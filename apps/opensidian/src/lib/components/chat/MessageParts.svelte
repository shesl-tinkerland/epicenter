<script lang="ts">
	import type { AgentMessagePart } from '@epicenter/workspace/agent';
	import ToolCallPart from './ToolCallPart.svelte';
	import ToolResultPart from './ToolResultPart.svelte';

	let {
		parts,
		pendingApprovalCallId,
		onApproveToolCall,
		onDenyToolCall,
	}: {
		parts: AgentMessagePart[];
		/** The tool call awaiting a decision, or null. */
		pendingApprovalCallId: string | null;
		onApproveToolCall: () => void;
		onDenyToolCall: () => void;
	} = $props();

	/**
	 * Exhaustiveness guard for the template's part dispatch: `part` is `never`
	 * only while every member of `AgentMessagePart` has a branch above the
	 * `{:else}`, so a new part type becomes a type error here.
	 *
	 * The branch is still reachable at runtime: a finished message round-trips
	 * through the workspace CRDT as plain JSON, so a newer build can persist
	 * part types this build does not know about.
	 */
	function unknownPartType(part: never): string {
		return (part as { type: string }).type;
	}
</script>

{#each parts as part, i (`${part.type}-${i}`)}
	{#if part.type === 'text'}
		<p class="whitespace-pre-wrap text-sm">{part.text}</p>
	{:else if part.type === 'tool-call'}
		<ToolCallPart
			{part}
			awaitingApproval={part.toolCallId === pendingApprovalCallId}
			{onApproveToolCall}
			{onDenyToolCall}
		/>
	{:else if part.type === 'tool-result'}
		<ToolResultPart {part} />
	{:else}
		<div class="py-1 text-xs text-muted-foreground italic">
			[Unsupported part: {unknownPartType(part)}]
		</div>
	{/if}
{/each}
