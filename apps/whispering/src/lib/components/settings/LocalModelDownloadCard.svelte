<script lang="ts">
	import { Badge } from '@epicenter/ui/badge';
	import { Button } from '@epicenter/ui/button';
	import { Progress } from '@epicenter/ui/progress';
	import { Spinner } from '@epicenter/ui/spinner';
	import CheckIcon from '@lucide/svelte/icons/check';
	import Download from '@lucide/svelte/icons/download';
	import X from '@lucide/svelte/icons/x';
	import { type LocalModelConfig } from '$lib/constants/local-models';
	import { localModelDownloads } from '$lib/state/local-model-downloads.svelte';

	let {
		model,
	}: {
		model: LocalModelConfig;
	} = $props();

	const download = $derived(localModelDownloads.get(model));

	// Aliased so the template narrows the union per branch.
	const state = $derived(download.state);
</script>

<div
	class="flex items-center gap-3 p-3 rounded-lg border {state.type === 'active'
		? 'border-primary bg-primary/5'
		: ''}"
>
	<div class="flex-1">
		<div class="flex items-center gap-2">
			<span class="font-medium">{model.name}</span>
			{#if model.recommended}
				<Badge variant="outline" class="text-xs">Recommended</Badge>
			{/if}
			{#if state.type === 'active'}
				<Badge variant="default" class="text-xs">Active</Badge>
			{:else if state.type === 'ready'}
				<Badge variant="secondary" class="text-xs">Downloaded</Badge>
			{/if}
		</div>
		<div class="text-sm text-muted-foreground">{model.description}</div>
		<div class="text-xs text-muted-foreground mt-1">{model.size}</div>
	</div>

	<div class="flex items-center gap-2">
		{#if state.type === 'downloading'}
			<div class="flex items-center gap-2 min-w-[120px]">
				<Spinner />
				<span class="text-sm font-medium">{state.progress}%</span>
			</div>
		{:else if state.type === 'ready'}
			<Button size="sm" variant="outline" onclick={() => download.activate()}>
				Activate
			</Button>
			<Button size="sm" variant="ghost" onclick={() => download.delete()}>
				<X class="size-4" />
			</Button>
		{:else if state.type === 'active'}
			<Button size="sm" variant="default" disabled>
				<CheckIcon class="size-4 mr-1" />
				Activated
			</Button>
			<Button size="sm" variant="ghost" onclick={() => download.delete()}>
				<X class="size-4" />
			</Button>
		{:else}
			<Button size="sm" variant="outline" onclick={() => download.download()}>
				<Download class="size-4" />
				Download
			</Button>
		{/if}
	</div>
</div>

{#if state.type === 'downloading' && state.progress > 0}
	<Progress value={state.progress} class="mt-2 h-2" />
{/if}
