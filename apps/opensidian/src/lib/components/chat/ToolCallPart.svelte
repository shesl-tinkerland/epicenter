<script lang="ts">
	import { Badge } from '@epicenter/ui/badge';
	import { Button } from '@epicenter/ui/button';
	import ShieldAlertIcon from '@lucide/svelte/icons/shield-alert';
	import WrenchIcon from '@lucide/svelte/icons/wrench';
	import type { AgentToolCallPart } from '@epicenter/workspace/agent';

	let {
		part,
		awaitingApproval,
		onApproveToolCall,
		onDenyToolCall,
	}: {
		part: AgentToolCallPart;
		/** This call is paused on the user's decision. */
		awaitingApproval: boolean;
		onApproveToolCall: () => void;
		onDenyToolCall: () => void;
	} = $props();

	const displayName = $derived(
		part.toolName
			.split('_')
			.map((word) => word.charAt(0).toUpperCase() + word.slice(1))
			.join(' '),
	);

	const argumentsText = $derived(JSON.stringify(part.input, null, 2));
</script>

<div class="flex flex-col gap-1 py-1">
	<div class="flex items-center gap-1.5">
		{#if awaitingApproval}
			<ShieldAlertIcon class="size-3 text-amber-500" />
		{:else}
			<WrenchIcon class="size-3 text-muted-foreground" />
		{/if}
		<Badge variant={awaitingApproval ? 'secondary' : 'status.running'}>
			{displayName}
		</Badge>
	</div>

	{#if awaitingApproval}
		<div class="flex items-center gap-1.5 pl-[1.125rem]">
			<Button variant="outline" size="sm" onclick={onApproveToolCall}>
				Allow
			</Button>
			<Button
				variant="ghost"
				size="sm"
				class="text-muted-foreground"
				onclick={onDenyToolCall}
			>
				Deny
			</Button>
		</div>
	{/if}

	{#if argumentsText !== '{}'}
		<details class="pl-[1.125rem]">
			<summary
				class="cursor-pointer text-xs text-muted-foreground hover:text-foreground"
			>
				Arguments
			</summary>
			<pre
				class="mt-1 whitespace-pre-wrap break-all rounded-md bg-muted/50 p-2 font-mono text-[11px]"
			>{argumentsText}</pre>
		</details>
	{/if}
</div>
