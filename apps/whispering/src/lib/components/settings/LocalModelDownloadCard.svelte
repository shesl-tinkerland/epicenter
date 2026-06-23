<script lang="ts">
	import { Badge } from '@epicenter/ui/badge';
	import { Button } from '@epicenter/ui/button';
	import { Progress } from '@epicenter/ui/progress';
	import { toast } from '@epicenter/ui/sonner';
	import { Spinner } from '@epicenter/ui/spinner';
	import CheckIcon from '@lucide/svelte/icons/check';
	import Download from '@lucide/svelte/icons/download';
	import X from '@lucide/svelte/icons/x';
	import {
		type LocalModelConfig,
		modelEntryName,
	} from '$lib/constants/local-models';
	import { deleteModelEntry } from '$lib/services/transcription/local-model-folder';
	import type { ModelFolder } from '$lib/state/model-folder.svelte';
	import {
		announceModelDelete,
		announceModelDownload,
	} from './local-model-toasts';

	let {
		folder,
		model,
		value = $bindable(),
		recommended = false,
	}: {
		/** The shared folder store, owned by the selector and passed to every row. */
		folder: ModelFolder;
		model: LocalModelConfig;
		/** Bindable selected folder entry name for this engine. */
		value: string;
		/** Show the Recommended badge; the selector decides when it guides a choice. */
		recommended?: boolean;
	} = $props();

	// Aliased so the template narrows the union per branch. The state comes from
	// the shared store, so a download started anywhere shows its progress here.
	const modelState = $derived(folder.stateOf(model));
	const entryName = $derived(modelEntryName(model));
	const isActive = $derived(value === entryName && modelState.type === 'ready');

	async function downloadModel() {
		// The store re-scans itself on completion, so the shared selector reacts.
		const downloaded = announceModelDownload(await folder.download(model));
		if (!downloaded) return;
		value = downloaded;
	}

	async function deleteModel() {
		if (
			!announceModelDelete(
				await deleteModelEntry({ engine: model.engine, name: entryName }),
			)
		)
			return;
		if (value === entryName) value = '';
		await folder.refresh();
	}

	async function activateModel() {
		value = entryName;
		toast.success('Model activated');
	}

	async function cancelDownload() {
		await folder.cancel(model);
	}
</script>

<div
	class="flex items-center gap-3 p-3 rounded-lg border {isActive
		? 'border-primary bg-primary/5'
		: ''}"
>
	<div class="flex-1">
		<div class="flex items-center gap-2">
			<span class="font-medium">{model.name}</span>
			{#if recommended}
				<Badge variant="outline" class="text-xs">Recommended</Badge>
			{/if}
			{#if isActive}
				<Badge variant="default" class="text-xs">Active</Badge>
			{:else if modelState.type === 'ready'}
				<Badge variant="secondary" class="text-xs">Downloaded</Badge>
			{/if}
		</div>
		<div class="text-sm text-muted-foreground">{model.description}</div>
		<div class="text-xs text-muted-foreground mt-1">{model.size}</div>
	</div>

	<div class="flex items-center gap-2">
		{#if modelState.type === 'downloading'}
			<div class="flex items-center gap-2">
				<Spinner />
				<span class="text-sm font-medium tabular-nums">
					{modelState.progress}%
				</span>
			</div>
			<Button
				size="sm"
				variant="ghost"
				onclick={cancelDownload}
				disabled={modelState.cancelling}
			>
				<X class="size-4 mr-1" />
				{modelState.cancelling ? 'Cancelling…' : 'Cancel'}
			</Button>
		{:else if modelState.type === 'ready'}
			{#if isActive}
				<Button size="sm" variant="default" disabled>
					<CheckIcon class="size-4 mr-1" />
					Activated
				</Button>
			{:else}
				<Button size="sm" variant="outline" onclick={activateModel}>
					Activate
				</Button>
			{/if}
			<Button size="sm" variant="ghost" onclick={deleteModel}>
				<X class="size-4" />
			</Button>
		{:else}
			<Button size="sm" variant="outline" onclick={downloadModel}>
				<Download class="size-4" />
				Download
			</Button>
		{/if}
	</div>
</div>

{#if modelState.type === 'downloading' && modelState.progress > 0}
	<Progress value={modelState.progress} class="mt-2 h-2" />
{/if}
