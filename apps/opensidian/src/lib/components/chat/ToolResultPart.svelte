<script lang="ts">
	import AlertCircleIcon from '@lucide/svelte/icons/circle-alert';
	import CheckIcon from '@lucide/svelte/icons/check';
	import type { AgentToolResultPart } from '@epicenter/workspace/agent';

	let {
		part,
	}: {
		part: AgentToolResultPart;
	} = $props();

	const outputText = $derived(
		typeof part.output === 'string'
			? part.output
			: JSON.stringify(part.output, null, 2),
	);
</script>

{#if part.isError}
	<div
		class="flex items-start gap-1.5 rounded-md bg-destructive/10 px-2 py-1.5 text-xs text-destructive"
	>
		<AlertCircleIcon class="mt-0.5 size-3 shrink-0" />
		<span class="whitespace-pre-wrap break-all">{outputText}</span>
	</div>
{:else}
	<details class="pl-[1.125rem]">
		<summary
			class="flex cursor-pointer items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
		>
			<CheckIcon class="size-3 text-emerald-500" />
			Result
		</summary>
		<pre
			class="mt-1 whitespace-pre-wrap break-all rounded-md bg-muted/50 p-2 font-mono text-[11px]"
		>{outputText}</pre>
	</details>
{/if}
