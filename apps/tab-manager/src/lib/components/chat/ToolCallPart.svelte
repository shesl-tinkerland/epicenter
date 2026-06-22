<script lang="ts">
	import { Badge } from '@epicenter/ui/badge';
	import { Button } from '@epicenter/ui/button';
	import ShieldAlertIcon from '@lucide/svelte/icons/shield-alert';
	import WrenchIcon from '@lucide/svelte/icons/wrench';
	import type { AgentToolCallPart } from '@epicenter/workspace/agent';
	import { requireTabManager } from '$lib/session.svelte';
	import CollapsibleSection from '../CollapsibleSection.svelte';

	const tabManager = requireTabManager();
	let {
		part,
		awaitingApproval,
		onApproveToolCall,
		onDenyToolCall,
		onAlwaysAllowToolCall,
	}: {
		part: AgentToolCallPart;
		/** This call is paused on the user's decision. */
		awaitingApproval: boolean;
		onApproveToolCall: () => void;
		onDenyToolCall: () => void;
		onAlwaysAllowToolCall: () => void;
	} = $props();

	/** The action's declared title, else the tool name title-cased. */
	const actionTitles = $derived(
		tabManager.actions as Record<string, { title?: string }>,
	);
	const displayName = $derived(
		actionTitles[part.toolName]?.title ??
			part.toolName
				.split('_')
				.map((word) => word.charAt(0).toUpperCase() + word.slice(1))
				.join(' '),
	);

	const argumentsText = $derived(JSON.stringify(part.input, null, 2));
</script>

{#snippet codeBlock(text: string)}
	<pre
		class="mt-0.5 whitespace-pre-wrap break-all font-mono text-[11px]"
	>{text}</pre>
{/snippet}

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
			<Button variant="outline" size="sm" onclick={onAlwaysAllowToolCall}>
				Always Allow
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
		<CollapsibleSection label="Arguments" contentClass="bg-muted/50">
			{@render codeBlock(argumentsText)}
		</CollapsibleSection>
	{/if}
</div>
