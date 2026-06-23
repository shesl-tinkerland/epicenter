<script lang="ts">
	import { Badge } from '@epicenter/ui/badge';
	import { Button } from '@epicenter/ui/button';
	import * as Card from '@epicenter/ui/card';
	import * as Empty from '@epicenter/ui/empty';
	import * as Field from '@epicenter/ui/field';
	import * as Item from '@epicenter/ui/item';
	import { Progress } from '@epicenter/ui/progress';
	import { toast } from '@epicenter/ui/sonner';
	import CheckIcon from '@lucide/svelte/icons/check';
	import Download from '@lucide/svelte/icons/download';
	import FolderOpen from '@lucide/svelte/icons/folder-open';
	import HardDriveDownload from '@lucide/svelte/icons/hard-drive-download';
	import Link from '@lucide/svelte/icons/link';
	import X from '@lucide/svelte/icons/x';
	import type { Snippet } from 'svelte';
	import {
		type LocalModelConfig,
		modelEntryName,
		RECOMMENDED_MODELS,
	} from '$lib/constants/local-models';
	import {
		deleteModelEntry,
		linkModelEntry,
		type ModelEntry,
		revealModelsFolder,
	} from '$lib/services/transcription/local-model-folder';
	import { PROVIDERS } from '$lib/services/transcription/providers';
	import { modelFolder } from '$lib/state/model-folder.svelte';
	import {
		announceModelDelete,
		announceModelDownload,
	} from './local-model-toasts';
	import LocalModelDownloadCard from './LocalModelDownloadCard.svelte';

	/**
	 * The engine's model library, in two shapes. `compact` (the first-run
	 * wizard) is a single hero: download the recommended model, or a one-line
	 * summary of the active one. Full (the settings page) is a flat list of
	 * every model, no disclosure: catalog rows you download/activate, any custom
	 * on-disk entries, and a bring-your-own footer. The list is backed by the
	 * engine's models folder; the bindable value is the active entry's name.
	 *
	 * `bare` drops the surrounding card chrome so a host (the first-run panel)
	 * can present the hero as attached content rather than a card-in-a-card.
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

		/** Render the hero only, for the first-run wizard. See the type doc. */
		compact?: boolean;

		/**
		 * Drop the surrounding card chrome (border, header title/description) and
		 * render the body inline, so a host can present the hero as content
		 * attached to its own surface rather than a card-in-a-card.
		 */
		bare?: boolean;
	};

	let {
		models,
		title,
		description,
		value = $bindable(),
		footer,
		compact = false,
		bare = false,
	}: LocalModelSelectorProps = $props();

	const engine = $derived(models[0].engine);
	const modelKind = $derived(PROVIDERS[engine].modelKind);

	// The one shared folder store for this engine: the single source of disk state
	// (the scan) and in-flight downloads. Every view (this selector, its hero, each
	// catalog row) reads it, so a download started anywhere updates them all
	// reactively; nothing here keeps a private scan that could go stale.
	const folder = $derived(modelFolder(models));

	// Re-scan on mount and when the engine changes. The store persists across
	// mounts, so an explicit refresh here catches a folder that changed while it
	// was unmounted; window focus catches changes made while mounted.
	$effect(() => {
		folder.refresh();
	});

	const customEntries = $derived(folder.customEntries());

	/** The catalog model behind the active entry, when it is a catalog one. */
	const activeCatalogModel = $derived(
		models.find((model) => modelEntryName(model) === value) ?? null,
	);

	const activeCustomEntry = $derived(
		customEntries.find((entry) => entry.name === value) ?? null,
	);

	// "Missing" means nothing in the folder backs the active selection. One truth:
	// the store's scan, which is global and reactive, so a model downloaded after
	// the user navigated away no longer reads as missing and needs no special-case.
	const isSelectionMissing = $derived(
		!!value && folder.loaded && !folder.present(value),
	);

	/** The engine's default download; the hero builds its action around it. */
	const recommended = $derived(RECOMMENDED_MODELS[engine]);

	// Aliased so the template narrows the union per branch. Shared with the catalog
	// row for the same model, so a download started here shows its progress there.
	const recommendedState = $derived(folder.stateOf(recommended));

	async function downloadRecommendedModel() {
		// The store re-scans itself on completion, so `value` lands on a present
		// entry instead of flashing "Selected model is missing".
		const downloaded = announceModelDownload(await folder.download(recommended));
		if (!downloaded) return;
		value = downloaded;
	}

	async function cancelRecommendedDownload() {
		await folder.cancel(recommended);
	}

	/** Point the engine's selection at an on-disk entry by name. */
	function activate(name: string) {
		value = name;
		toast.success('Model activated');
	}

	async function openModelsFolder() {
		const { error } = await revealModelsFolder(engine);
		if (error) {
			toast.error('Failed to open models folder', {
				description: error.message,
			});
		}
	}

	/**
	 * Link a model already on disk instead of downloading a copy. Picks a file
	 * (Whisper) or directory (Parakeet/Moonshine), then has Rust validate the
	 * engine shape and create a symlink entry named after the source. The native
	 * side is the trust boundary: an incompatible pick fails with its reason.
	 */
	async function linkModel() {
		const { open } = await import('@tauri-apps/plugin-dialog');
		const { basename } = await import('@tauri-apps/api/path');
		const selected = await open({
			directory: modelKind === 'directory',
			multiple: false,
			title: `Link a ${title}`,
			filters:
				modelKind === 'directory'
					? undefined
					: [{ name: 'Whisper model', extensions: ['bin', 'gguf', 'ggml'] }],
		});
		if (typeof selected !== 'string') return;

		const entryName = await basename(selected);
		const { error } = await linkModelEntry({
			engine,
			entryName,
			sourcePath: selected,
		});
		if (error) {
			// A name collision is the common dedup case: an external copy shares the
			// model's canonical name with one already installed. Name it and open the
			// folder, since the folder is the truth this list mirrors: delete the
			// existing one there and the onfocus rescan picks up the relink.
			if (error.name === 'EntryExists') {
				toast.error(`"${error.entry}" is already installed`, {
					description: `Whispering won't overwrite it. To use this copy instead, delete "${error.entry}" from Whispering's models folder, then link it again.`,
					action: {
						label: 'Open Models Folder',
						onClick: () => void openModelsFolder(),
					},
				});
				return;
			}
			toast.error('Could not link that model', { description: error.message });
			return;
		}
		// Rescan before selecting so the new link is already in the list when
		// `value` flips (no transient "Selected model is missing" flash).
		await folder.refresh();
		value = entryName;
		toast.success('Model linked', {
			description: `${entryName} now points to your file. Deleting it later removes only the link.`,
		});
	}

	async function removeEntry(entry: ModelEntry) {
		if (!announceModelDelete(await deleteModelEntry({ engine, name: entry.name })))
			return;
		if (value === entry.name) value = '';
		await folder.refresh();
	}
</script>

<svelte:window onfocus={folder.refresh} />

{#snippet body()}
	{#if isSelectionMissing}
		<div class="rounded-lg border border-amber-500/20 bg-amber-500/5 p-3">
			<p class="text-sm font-medium text-amber-600 dark:text-amber-400">
				Selected model is missing
			</p>
			<p class="mt-1 text-sm text-muted-foreground">
				"{value}" is no longer in the models folder. Download it again, or add
				your own and activate it.
			</p>
		</div>
	{/if}

	{#if compact}
		<!-- First-run hero: one action, not the whole library. -->
		{#if value && !isSelectionMissing}
			<Item.Root variant="outline">
				<Item.Content>
					<Item.Title>
						{activeCatalogModel ? activeCatalogModel.name : value}
					</Item.Title>
					<Item.Description>
						{#if activeCatalogModel}
							{activeCatalogModel.size}
						{:else if activeCustomEntry?.linked}
							Your model (linked)
						{:else}
							Your model
						{/if}
					</Item.Description>
				</Item.Content>
				<Item.Actions>
					<Badge class="text-xs">Active</Badge>
				</Item.Actions>
			</Item.Root>
		{:else if !value}
			<Empty.Root class="py-6">
				<Empty.Media variant="icon">
					<HardDriveDownload class="size-5" />
				</Empty.Media>
				<Empty.Title>No local model installed</Empty.Title>
				<Empty.Description>
					Download the recommended model to start transcribing on this device.
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
							Download recommended model ({recommended.size})
						</Button>
					{/if}
				</Empty.Content>
			</Empty.Root>
		{/if}
	{:else}
		<!-- Settings: the whole library as a flat list, no disclosure. -->
		{#each models as model (model.id)}
			<LocalModelDownloadCard
				{folder}
				{model}
				bind:value
				recommended={models.length > 1 && model.id === recommended.id}
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
						{entry.linked ? 'Your model (linked)' : 'Your model'}
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
					<Button size="sm" variant="ghost" onclick={() => removeEntry(entry)}>
						<X class="size-4" />
					</Button>
				</div>
			</div>
		{/each}

		<div class="rounded-lg border bg-muted/50 p-4 space-y-3">
			<Field.Description>
				Have your own model? Link a {modelKind === 'directory'
					? 'model directory'
					: 'model file (.bin, .gguf, or .ggml)'} from anywhere on disk and it
				appears in this list, without copying a second copy. Or drop one into the
				models folder yourself.
			</Field.Description>
			<div class="flex flex-wrap gap-2">
				<Button variant="outline" size="sm" onclick={linkModel}>
					<Link class="size-4 mr-2" />
					Link a model
				</Button>
				<Button variant="outline" size="sm" onclick={openModelsFolder}>
					<FolderOpen class="size-4 mr-2" />
					Open Models Folder
				</Button>
			</div>
			{#if footer}
				{@render footer()}
			{/if}
		</div>
	{/if}
{/snippet}

{#if bare}
	<div class="space-y-3">
		{@render body()}
	</div>
{:else}
	<Card.Root>
		<Card.Header>
			<Card.Title class="text-lg">{title}</Card.Title>
			<Card.Description>{description}</Card.Description>
		</Card.Header>
		<Card.Content class="space-y-3">
			{@render body()}
		</Card.Content>
	</Card.Root>
{/if}
