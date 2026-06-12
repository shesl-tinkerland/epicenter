<script lang="ts">
	import { Badge } from '@epicenter/ui/badge';
	import { Button } from '@epicenter/ui/button';
	import { Progress } from '@epicenter/ui/progress';
	import { toast } from '@epicenter/ui/sonner';
	import { Spinner } from '@epicenter/ui/spinner';
	import CheckIcon from '@lucide/svelte/icons/check';
	import Download from '@lucide/svelte/icons/download';
	import X from '@lucide/svelte/icons/x';
	import { type LocalModelConfig } from '$lib/constants/local-models';
	import { createPrebuiltModel } from '$lib/operations/local-models';

	let {
		model,
	}: {
		model: LocalModelConfig;
	} = $props();

	const prebuiltModel = $derived(createPrebuiltModel(model));

	type ModelState =
		| { type: 'not-downloaded' }
		| { type: 'downloading'; progress: number }
		| { type: 'ready' }
		| { type: 'active' };

	let modelState = $state<ModelState>({ type: 'not-downloaded' });

	// Check model status on mount and whenever the engine's active model
	// path changes (the getter reads deviceConfig, so this effect tracks it).
	$effect(() => {
		void prebuiltModel.activeModelPath;
		refreshStatus();
	});

	async function refreshStatus() {
		const status = await prebuiltModel.getStatus();
		// While downloading, the download handler owns the state machine; a
		// download may also have started while we were checking the disk.
		if (modelState.type === 'downloading') return;
		modelState = { type: status };
	}

	async function downloadModel() {
		if (modelState.type === 'downloading') return;

		modelState = { type: 'downloading', progress: 0 };

		const { data, error } = await prebuiltModel.downloadAndActivate({
			onProgress: (progress) => {
				modelState = { type: 'downloading', progress };
			},
		});
		if (error) {
			toast.error('Failed to download model', {
				description: error.message,
			});
			modelState = { type: 'not-downloaded' };
			return;
		}

		modelState = { type: 'active' };
		toast.success(
			data.outcome === 'already-installed'
				? 'Model already downloaded and activated'
				: 'Model downloaded and activated successfully',
		);
	}

	async function activateModel() {
		await prebuiltModel.activate();
		// The settings watcher will update modelState to 'active'
		toast.success('Model activated');
	}

	async function deleteModel() {
		const { error } = await prebuiltModel.delete();
		if (error) {
			toast.error('Failed to delete model', {
				description: error.message,
			});
			return;
		}
		modelState = { type: 'not-downloaded' };
		toast.success('Model deleted');
	}
</script>

<div
	class="flex items-center gap-3 p-3 rounded-lg border {modelState.type ===
	'active'
		? 'border-primary bg-primary/5'
		: ''}"
>
	<div class="flex-1">
		<div class="flex items-center gap-2">
			<span class="font-medium">{model.name}</span>
			{#if model.recommended}
				<Badge variant="outline" class="text-xs">Recommended</Badge>
			{/if}
			{#if modelState.type === 'active'}
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
			<div class="flex items-center gap-2 min-w-[120px]">
				<Spinner />
				<span class="text-sm font-medium">{modelState.progress}%</span>
			</div>
		{:else if modelState.type === 'ready'}
			<Button size="sm" variant="outline" onclick={activateModel}>
				Activate
			</Button>
			<Button size="sm" variant="ghost" onclick={deleteModel}>
				<X class="size-4" />
			</Button>
		{:else if modelState.type === 'active'}
			<Button size="sm" variant="default" disabled>
				<CheckIcon class="size-4 mr-1" />
				Activated
			</Button>
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
