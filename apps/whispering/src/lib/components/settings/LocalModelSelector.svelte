<script lang="ts">
	import { Badge } from '@epicenter/ui/badge';
	import { Button } from '@epicenter/ui/button';
	import * as Card from '@epicenter/ui/card';
	import * as Collapsible from '@epicenter/ui/collapsible';
	import * as Empty from '@epicenter/ui/empty';
	import { Input } from '@epicenter/ui/input';
	import * as Item from '@epicenter/ui/item';
	import { Progress } from '@epicenter/ui/progress';
	import { toast } from '@epicenter/ui/sonner';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import Download from '@lucide/svelte/icons/download';
	import FolderOpen from '@lucide/svelte/icons/folder-open';
	import HardDriveDownload from '@lucide/svelte/icons/hard-drive-download';
	import Paperclip from '@lucide/svelte/icons/paperclip';
	import X from '@lucide/svelte/icons/x';
	import { basename } from '@tauri-apps/api/path';
	import { open } from '@tauri-apps/plugin-dialog';
	import type { Snippet } from 'svelte';
	import type { LocalModelConfig } from '$lib/constants/local-models';
	import {
		importModelDirectory,
		importModelFile,
	} from '$lib/services/transcription/local-model-storage';
	import { PROVIDERS } from '$lib/services/transcription/providers';
	import { localModelDownloads } from '$lib/state/local-model-downloads.svelte';
	import { tauri } from '#platform/tauri';
	import LocalModelDownloadCard from './LocalModelDownloadCard.svelte';

	/**
	 * Props for the LocalModelSelector component
	 */
	type LocalModelSelectorProps = {
		/**
		 * Pre-built models available for download. All entries share one
		 * engine; at least one is required because the engine decides where
		 * manual imports land.
		 */
		models: readonly [LocalModelConfig, ...LocalModelConfig[]];

		/** Component title displayed in the card header */
		title: string;

		/** Component description displayed below the title */
		description: string;

		/** File extensions to filter (for file mode only) */
		fileExtensions?: string[];

		/** Bindable value with getter/setter for the model path */
		value: string;

		/** Optional footer content for the expanded model catalog */
		catalogFooter?: Snippet;

		/** Help text shown above the bring-your-own-model path picker */
		manualHelp?: Snippet;
	};

	let {
		models,
		title,
		description,
		fileExtensions = [],
		value = $bindable(),
		catalogFooter,
		manualHelp,
	}: LocalModelSelectorProps = $props();

	const engine = $derived(models[0].engine);

	// Not a free choice: an imported path must match what the engine's
	// preflight accepts (a file for Whisper, a directory for Parakeet and
	// Moonshine), so the mode comes from the provider registry.
	const fileSelectionMode = $derived(PROVIDERS[engine].preflightKind);

	// Extract the model name from the current path
	const modelName = $derived.by(async () => {
		const path = value;
		if (!path) return '';
		return basename(path);
	});

	// Check if current model is pre-built
	const prebuiltModelInfo = $derived(
		models.find((m) => {
			if (!value) return false;
			switch (m.engine) {
				case 'whispercpp':
					return value.endsWith(m.file.filename);
				case 'parakeet':
				case 'moonshine':
					return value.endsWith(m.directoryName);
			}
		}) ?? null,
	);

	/** Whether the full catalog (and the manual picker inside it) is expanded. */
	let allModelsOpen = $state(false);

	// The engine's default download. The catalog marks exactly one model as
	// recommended; falling back to the first entry keeps the primary action
	// rendering even if the catalog ever loses the flag.
	const recommended = $derived(models.find((m) => m.recommended) ?? models[0]);
	const recommendedDownload = $derived(localModelDownloads.get(recommended));

	// Aliased so the template narrows the union per branch. Shared with the
	// catalog row for the same model, so a download started here shows its
	// progress there too.
	const recommendedState = $derived(recommendedDownload.state);

	/**
	 * Open file/folder browser for manual model selection
	 */
	async function selectModel() {
		if (!tauri) return;

		if (fileSelectionMode === 'directory') {
			const selected = await open({
				directory: true,
				multiple: false,
				title: `Select ${title} Directory`,
			});
			if (!selected) return;

			const { data, error } = await importModelDirectory({
				engine,
				sourceDir: selected,
			});
			if (error) {
				toast.error('Failed to select model', {
					description: error.message,
				});
				return;
			}
			value = data.path;
			toast.success('Model directory imported');
		} else {
			const filters =
				fileExtensions.length > 0
					? [
							{
								name: `${title} Files`,
								extensions: fileExtensions,
							},
						]
					: [];

			const selected = await open({
				multiple: false,
				filters,
				title: `Select ${title} File`,
			});
			if (!selected) return;

			const { data, error } = await importModelFile({
				engine,
				sourcePath: selected,
			});
			if (error) {
				toast.error('Failed to select model', {
					description: error.message,
				});
				return;
			}
			value = data.path;
			toast.success('Model file imported');
		}
	}

	/**
	 * Clear the currently selected model
	 */
	function clearModel() {
		value = '';
		toast.success('Model path cleared');
	}
</script>

<Card.Root>
	<Card.Header>
		<Card.Title class="text-lg">{title}</Card.Title>
		<Card.Description>{description}</Card.Description>
	</Card.Header>
	<Card.Content class="space-y-3">
		{#if value}
			<Item.Root variant="outline">
				<Item.Content>
					<Item.Title>
						{#if prebuiltModelInfo}
							{prebuiltModelInfo.name}
						{:else}
							{#await modelName then name}
								{name || 'Your own model'}
							{/await}
						{/if}
					</Item.Title>
					<Item.Description>
						{prebuiltModelInfo ? prebuiltModelInfo.size : 'Your own model'}
					</Item.Description>
				</Item.Content>
				<Item.Actions>
					<Badge class="text-xs">Active</Badge>
					<Button
						variant="outline"
						size="sm"
						onclick={() => (allModelsOpen = !allModelsOpen)}
					>
						Change
					</Button>
				</Item.Actions>
			</Item.Root>
		{:else}
			<Empty.Root class="py-8">
				<Empty.Media variant="icon">
					<HardDriveDownload class="size-5" />
				</Empty.Media>
				<Empty.Title>No model installed</Empty.Title>
				<Empty.Description>
					Download the recommended model to start transcribing on this
					device.
				</Empty.Description>
				<Empty.Content>
					{#if recommendedState.type === 'downloading'}
						<div class="flex w-full max-w-xs flex-col items-center gap-2">
							<Progress value={recommendedState.progress} class="h-2" />
							<span class="text-sm text-muted-foreground">
								Downloading {recommended.name}: {recommendedState.progress}%
							</span>
						</div>
					{:else if recommendedState.type === 'ready'}
						<Button onclick={() => recommendedDownload.activate()}>
							Activate {recommended.name}
						</Button>
					{:else}
						<Button onclick={() => recommendedDownload.download()}>
							<Download class="size-4" />
							Download {recommended.name} ({recommended.size})
						</Button>
					{/if}
				</Empty.Content>
			</Empty.Root>
		{/if}

		<Collapsible.Root bind:open={allModelsOpen}>
			<Collapsible.Trigger
				class="flex w-full items-center justify-between rounded-lg border px-4 py-3 text-sm font-medium transition-colors hover:bg-muted/50 [&[data-state=open]>svg]:rotate-180"
			>
				All models ({models.length})
				<ChevronDown
					class="size-4 shrink-0 text-muted-foreground transition-transform"
				/>
			</Collapsible.Trigger>
			<Collapsible.Content class="space-y-3 pt-3">
				{#each models as model (model.id)}
					<LocalModelDownloadCard {model} />
				{/each}

				{#if catalogFooter}
					<div class="rounded-lg border bg-muted/50 p-4">
						{@render catalogFooter()}
					</div>
				{/if}

				<Collapsible.Root>
					<Collapsible.Trigger
						class="flex items-center gap-1.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground [&[data-state=open]>svg]:rotate-90"
					>
						<ChevronRight class="size-4 transition-transform" />
						Use your own model
					</Collapsible.Trigger>
					<Collapsible.Content class="space-y-3 pt-3">
						{#if manualHelp}
							{@render manualHelp()}
						{/if}

						<div class="flex items-center gap-2">
							<Input
								type="text"
								{value}
								readonly
								placeholder="No model selected"
								class="flex-1"
							/>
							{#if value}
								<Button
									variant="outline"
									size="icon"
									onclick={clearModel}
									title="Clear model path"
								>
									<X class="size-4" />
								</Button>
							{/if}
							<Button variant="outline" onclick={selectModel}>
								{#if fileSelectionMode === 'directory'}
									<FolderOpen class="size-4" />
									Choose folder
								{:else}
									<Paperclip class="size-4" />
									Choose file
								{/if}
							</Button>
						</div>
					</Collapsible.Content>
				</Collapsible.Root>
			</Collapsible.Content>
		</Collapsible.Root>
	</Card.Content>
</Card.Root>
