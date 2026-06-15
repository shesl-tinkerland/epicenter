<script lang="ts">
	import { Badge } from '@epicenter/ui/badge';
	import { Button } from '@epicenter/ui/button';
	import * as Card from '@epicenter/ui/card';
	import * as Collapsible from '@epicenter/ui/collapsible';
	import * as Empty from '@epicenter/ui/empty';
	import * as Field from '@epicenter/ui/field';
	import * as Item from '@epicenter/ui/item';
	import { Progress } from '@epicenter/ui/progress';
	import { toast } from '@epicenter/ui/sonner';
	import CheckIcon from '@lucide/svelte/icons/check';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import Download from '@lucide/svelte/icons/download';
	import FolderOpen from '@lucide/svelte/icons/folder-open';
	import HardDriveDownload from '@lucide/svelte/icons/hard-drive-download';
	import X from '@lucide/svelte/icons/x';
	import { mkdir } from '@tauri-apps/plugin-fs';
	import type { Snippet } from 'svelte';
	import { extractErrorMessage } from 'wellcrafted/error';
	import { Ok, tryAsync } from 'wellcrafted/result';
	import {
		type LocalModelConfig,
		modelEntryName,
		RECOMMENDED_MODELS,
	} from '$lib/constants/local-models';
	import { PATHS } from '$lib/services/fs-paths';
	import {
		deleteModelEntry,
		listModelEntries,
		type LocalModelEntry,
	} from '$lib/services/transcription/local-model-folder';
	import { PROVIDERS } from '$lib/services/transcription/providers';
	import { localModelDownloads } from '$lib/state/local-model-downloads.svelte';
	import { tauri } from '#platform/tauri';
	import {
		announceModelDelete,
		announceModelDownload,
	} from './local-model-toasts';
	import LocalModelDownloadCard from './LocalModelDownloadCard.svelte';

	/**
	 * One happy path per engine: an empty-state hero that downloads the
	 * recommended model, or a summary row showing the active one. The full
	 * list (catalog download cards, custom folder entries, the folder help
	 * box) collapses behind "All models". The list is backed by the engine's
	 * models folder; the bindable value is the active entry's name.
	 */
	type LocalModelSelectorProps = {
		/**
		 * Pre-built models available for download. All entries share one
		 * engine; at least one is required because the engine decides which
		 * models folder backs this list.
		 */
		models: readonly [LocalModelConfig, ...LocalModelConfig[]];

		/** Component title displayed in the card header */
		title: string;

		/** Component description displayed below the title */
		description: string;

		/** Bindable name of the active entry in the engine's models folder */
		value: string;

		/** Optional footer content (download sources, naming notes) */
		footer?: Snippet;
	};

	let {
		models,
		title,
		description,
		value = $bindable(),
		footer,
	}: LocalModelSelectorProps = $props();

	const engine = $derived(models[0].engine);
	const modelKind = $derived(PROVIDERS[engine].modelKind);

	/** Folder entry names the catalog cards already represent. */
	const catalogNames = $derived(new Set(models.map(modelEntryName)));

	let entries = $state<LocalModelEntry[] | null>(null);

	const customEntries = $derived(
		(entries ?? []).filter((entry) => !catalogNames.has(entry.name)),
	);

	// The active selection vanished from the folder (deleted or renamed).
	const isSelectionMissing = $derived(
		!!value && entries !== null && !entries.some((e) => e.name === value),
	);

	/** The catalog model behind the active entry, when it is a catalog one. */
	const activeCatalogModel = $derived(
		models.find((model) => modelEntryName(model) === value) ?? null,
	);

	const activeCustomEntry = $derived(
		customEntries.find((entry) => entry.name === value) ?? null,
	);

	/** The engine's default download; the hero builds its action around it. */
	const recommended = $derived(RECOMMENDED_MODELS[engine]);
	const recommendedDownload = $derived(localModelDownloads.get(recommended));

	// Aliased so the template narrows the union per branch. Shared with the
	// catalog row for the same model, so a download started here shows its
	// progress there too.
	const recommendedState = $derived(recommendedDownload.state);

	/** Whether the full list behind "All models" is expanded. */
	let allModelsOpen = $state(false);

	// Plain variable, not $state: refreshEntries runs inside the rescan
	// effect, and a reactive read here would make the effect track entries
	// and re-run on its own assignment.
	let hasDecidedInitialOpen = false;

	async function refreshEntries() {
		if (!tauri) return;
		entries = await listModelEntries(engine);
		// The folder is user-editable truth, so the catalog handles re-check
		// disk on the same signal that rescans the folder. Await the disk-stat
		// so `isInstalled` (and the "Downloaded" badge it drives) is settled
		// before the listing renders, instead of racing the next render.
		await Promise.all(models.map((model) => localModelDownloads.get(model).refresh()));
		// A user who already brought their own model gets the list, not a
		// download pitch: when nothing is active and the first scan finds
		// custom entries, start with the list open instead of the hero.
		if (!hasDecidedInitialOpen) {
			hasDecidedInitialOpen = true;
			if (!value && customEntries.length > 0) allModelsOpen = true;
		}
	}

	async function downloadRecommendedModel() {
		const entryName = announceModelDownload(await recommendedDownload.download());
		if (!entryName) return;
		value = entryName;
		await refreshEntries();
	}

	async function cancelRecommendedDownload() {
		await recommendedDownload.cancel();
	}

	/** Point the engine's selection at an on-disk entry by name. */
	function activate(name: string) {
		value = name;
		toast.success('Model activated');
	}

	// Rescan on mount and when the engine changes. Selection changes do not
	// change disk; download/delete handlers refresh after they change the folder.
	$effect(() => {
		void engine;
		refreshEntries();
	});

	async function openModelsFolder() {
		await tryAsync({
			try: async () => {
				const modelsDir = await PATHS.MODELS[engine]();
				await mkdir(modelsDir, { recursive: true });
				const { openPath } = await import('@tauri-apps/plugin-opener');
				await openPath(modelsDir);
			},
			catch: (error) => {
				toast.error('Failed to open models folder', {
					description: extractErrorMessage(error),
				});
				return Ok(undefined);
			},
		});
	}

	async function removeEntry(entry: LocalModelEntry) {
		if (!announceModelDelete(await deleteModelEntry({ engine, name: entry.name })))
			return;
		if (value === entry.name) value = '';
		await refreshEntries();
	}
</script>

<svelte:window onfocus={refreshEntries} />

<Card.Root>
	<Card.Header>
		<Card.Title class="text-lg">{title}</Card.Title>
		<Card.Description>{description}</Card.Description>
	</Card.Header>
	<Card.Content class="space-y-3">
		{#if value && !isSelectionMissing}
			<Item.Root variant="outline">
				<Item.Content>
					<Item.Title>
						{activeCatalogModel ? activeCatalogModel.name : value}
					</Item.Title>
					<Item.Description>
						{#if activeCatalogModel}
							{activeCatalogModel.size}
						{:else if activeCustomEntry?.isSymlink}
							Your model (linked)
						{:else}
							Your model
						{/if}
					</Item.Description>
				</Item.Content>
				<Item.Actions>
					<Badge class="text-xs">Active</Badge>
					<Button
						variant="outline"
						size="sm"
						onclick={() => (allModelsOpen = true)}
					>
						Change
					</Button>
				</Item.Actions>
			</Item.Root>
		{:else if !value && customEntries.length === 0}
			<Empty.Root class="py-8">
				<Empty.Media variant="icon">
					<HardDriveDownload class="size-5" />
				</Empty.Media>
				<Empty.Title>No local model installed</Empty.Title>
				<Empty.Description>
					Runs on this device — private, offline, and free. Download the
					recommended model to start transcribing.
				</Empty.Description>
				<Empty.Content>
					{#if recommendedState.type === 'downloading'}
						<div class="flex w-full max-w-xs flex-col items-center gap-2">
							<Progress value={recommendedState.progress} class="h-2" />
							<span class="text-sm text-muted-foreground">
								Downloading {recommended.name}: {recommendedState.progress}%
							</span>
							<Button
								variant="ghost"
								size="sm"
								onclick={cancelRecommendedDownload}
								disabled={recommendedState.cancelling}
							>
								<X class="size-4" />
								{recommendedState.cancelling ? 'Cancelling…' : 'Cancel'}
							</Button>
						</div>
					{:else if recommendedState.type === 'ready'}
						<Button onclick={() => activate(modelEntryName(recommended))}>
							Activate {recommended.name}
						</Button>
					{:else}
						<Button onclick={downloadRecommendedModel}>
							<Download class="size-4" />
							Download {recommended.name} ({recommended.size})
						</Button>
					{/if}
				</Empty.Content>
			</Empty.Root>
		{/if}

		{#if isSelectionMissing}
			<div class="rounded-lg border border-amber-500/20 bg-amber-500/5 p-3">
				<p class="text-sm font-medium text-amber-600 dark:text-amber-400">
					Selected model is missing
				</p>
				<p class="mt-1 text-sm text-muted-foreground">
					"{value}" is no longer in the models folder. Pick another model under
					All models, or add yours back and activate it.
				</p>
			</div>
		{/if}

		<Collapsible.Root bind:open={allModelsOpen}>
			<Collapsible.Trigger
				class="flex w-full items-center justify-between rounded-lg border px-4 py-3 text-sm font-medium transition-colors hover:bg-muted/50 [&[data-state=open]>svg]:rotate-180"
			>
				All models ({models.length + customEntries.length})
				<ChevronDown
					class="size-4 shrink-0 text-muted-foreground transition-transform"
				/>
			</Collapsible.Trigger>
			<Collapsible.Content class="space-y-3 pt-3">
				{#each models as model (model.id)}
					<LocalModelDownloadCard
						{model}
						bind:value
						recommended={models.length > 1 && model.id === recommended.id}
						onDiskChange={refreshEntries}
					/>
				{/each}

				{#each customEntries as entry (entry.name)}
					{@const isActive = value === entry.name}
					<div
						class="flex items-center gap-3 p-3 rounded-lg border {isActive
							? 'border-primary bg-primary/5'
							: ''}"
					>
						<div class="flex-1">
							<div class="flex items-center gap-2">
								<span class="font-medium">{entry.name}</span>
								{#if isActive}
									<Badge variant="default" class="text-xs">Active</Badge>
								{/if}
							</div>
							<div class="text-sm text-muted-foreground">
								{entry.isSymlink ? 'Your model (linked)' : 'Your model'}
							</div>
						</div>

						<div class="flex items-center gap-2">
							{#if isActive}
								<Button size="sm" variant="default" disabled>
									<CheckIcon class="size-4 mr-1" />
									Activated
								</Button>
							{:else}
								<Button
									size="sm"
									variant="outline"
									onclick={() => activate(entry.name)}
								>
									Activate
								</Button>
							{/if}
							<Button
								size="sm"
								variant="ghost"
								onclick={() => removeEntry(entry)}
							>
								<X class="size-4" />
							</Button>
						</div>
					</div>
				{/each}

				<div class="rounded-lg border bg-muted/50 p-4 space-y-3">
					<Field.Description>
						Have your own model? Put a model {modelKind === 'directory'
							? 'directory'
							: 'file (.bin, .gguf, or .ggml)'} in the models folder and it appears
						in this list. A symlink works too if you'd rather not keep a second
						copy.
					</Field.Description>
					<Button variant="outline" size="sm" onclick={openModelsFolder}>
						<FolderOpen class="size-4 mr-2" />
						Open Models Folder
					</Button>
					{#if footer}
						{@render footer()}
					{/if}
				</div>
			</Collapsible.Content>
		</Collapsible.Root>
	</Card.Content>
</Card.Root>
