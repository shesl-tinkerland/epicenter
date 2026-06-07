<script lang="ts">
	import * as Alert from '@epicenter/ui/alert';
	import * as Empty from '@epicenter/ui/empty';
	import { Input } from '@epicenter/ui/input';
	import { Spinner } from '@epicenter/ui/spinner';
	import FolderOpenIcon from '@lucide/svelte/icons/folder-open';
	import FolderGrid from '$lib/components/FolderGrid.svelte';
	import { createVault } from '$lib/vault.svelte';
	import { createWhereFilter } from '$lib/where-filter.svelte';

	let { path }: { path: string } = $props();

	// This keyed component IS the live vault for the active route: construct on mount,
	// dispose on destroy. The route's `{#key data.path}` tears this instance down and
	// builds a fresh one when the active folder changes, so the OS watcher's lifetime
	// rides the component's, with no session singleton driving it.
	// svelte-ignore state_referenced_locally - the route keys this component on path, so it remounts (not re-renders) when the active folder changes; capturing the initial path here is the intent.
	const vault = createVault(path);
	$effect(() => () => vault.dispose());

	// One WHERE filter per tab: each open vault gets its own clause. The effect reads the
	// vault (and its rows, inside `resolve`) so it re-queries on a data change; the cleanup
	// cancels an in-flight query so a stale result never lands.
	const filter = createWhereFilter();
	$effect(() => filter.resolve(vault));
	const view = $derived(vault.read.view);
</script>

<div class="flex min-h-0 flex-1 flex-col">
	{#if view.mode === 'modeled'}
		<!-- WHERE filter: a SQL predicate run against matter.sqlite; the grid below narrows
		     to the matching rows, still typed and editable. -->
		<div class="flex min-h-12 items-center gap-3 border-b px-4 py-2">
			<div class="ml-auto flex items-center gap-1.5">
				<span
					class="font-mono text-[11px] font-medium uppercase tracking-wide text-muted-foreground"
				>
					where
				</span>
				<Input
					bind:value={filter.text}
					placeholder="status = 'ready'"
					spellcheck={false}
					autocapitalize="off"
					autocomplete="off"
					autocorrect="off"
					aria-invalid={Boolean(filter.error)}
					aria-label="Filter rows with a SQL WHERE clause"
					title={filter.error}
					class={[
						'h-8 w-72 font-mono text-xs',
						filter.error && 'border-destructive focus-visible:ring-destructive/30',
					]}
				/>
			</div>
		</div>
	{/if}

	{#await vault.whenReady}
		<Empty.Root class="flex-1 border-0" aria-live="polite">
			<Empty.Media><Spinner class="size-5 text-muted-foreground" /></Empty.Media>
			<Empty.Title>Loading {vault.folderName}</Empty.Title>
		</Empty.Root>
	{:then _}
		{#if vault.writeError}
			<Alert.Root variant="destructive" class="rounded-none border-x-0 border-t-0 py-2">
				<Alert.Description class="text-xs">
					Couldn't save: {vault.writeError}
				</Alert.Description>
			</Alert.Root>
		{/if}
		<FolderGrid {vault} matchedFileNames={filter.matchedFileNames} />
	{:catch error}
		<Empty.Root class="flex-1 border-0">
			<Empty.Media variant="icon"><FolderOpenIcon /></Empty.Media>
			<Empty.Title>Couldn't watch {vault.folderName}</Empty.Title>
			<Empty.Description>
				{error instanceof Error ? error.message : String(error)}
			</Empty.Description>
		</Empty.Root>
	{/await}
</div>
