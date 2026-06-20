<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as Empty from '@epicenter/ui/empty';
	import { Loading } from '@epicenter/ui/loading';
	import FolderOpenIcon from '@lucide/svelte/icons/folder-open';
	import LayersIcon from '@lucide/svelte/icons/layers';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { routes, TABLE_PARAM } from '$lib/routes';
	import { createVault } from '$lib/vault.svelte';
	import IntegrityPanel from './IntegrityPanel.svelte';
	import TablePane from './TablePane.svelte';

	let { root }: { root: string } = $props();

	// This keyed component IS the live vault for the active route: construct on mount, dispose on
	// destroy. The route's `{#key data.root}` tears this instance down and builds a fresh one when
	// the active vault changes, so the root watch AND every composed table watch ride this
	// component's lifetime, with no module singleton driving them.
	// svelte-ignore state_referenced_locally - the route keys this component on root, so it remounts (not re-renders) when the active vault changes; capturing the initial root here is the intent.
	const vault = createVault(root);
	$effect(() => () => vault.dispose());

	// Which table is active in the shell, addressed by folder NAME in the URL (`?table=`) so the
	// selection survives a refresh or a shared link and lives in the one place navigation belongs.
	// It is a selection over the always-live table set, not a resource with its own lifecycle (the
	// vault watches every table for cross-table integrity), so a query param fits: VaultShell stays
	// the vault's single owner and does not remount when the table changes. A missing, renamed, or
	// not-yet-loaded name falls through to the first table below, so no URL cleanup is needed.
	const activeName = $derived(page.url.searchParams.get(TABLE_PARAM) ?? undefined);
	const activeTable = $derived(
		vault.tables.find((table) => table.folderName === activeName) ??
			vault.tables[0],
	);

	// Adopt the root as a table (writes the `{}` marker). The watcher re-scans on the new marker and
	// surfaces the table live, so success needs no manual refresh; only a write failure shows here.
	let adopting = $state(false);
	let adoptError = $state<string | undefined>(undefined);
	async function adopt(): Promise<void> {
		adopting = true;
		adoptError = undefined;
		try {
			await vault.adopt();
		} catch (error) {
			adoptError = error instanceof Error ? error.message : String(error);
		} finally {
			adopting = false;
		}
	}
</script>

<div class="flex min-h-0 flex-1 flex-col">
	{#await vault.whenReady}
		<Loading class="flex-1" label="Loading {vault.folderName}" />
	{:then _}
		<!-- No tables means this folder is not marked and has no marked children (ADR-0029): matter is
		     a declared store, so it shows nothing until a folder is adopted. Offer to adopt the root
		     (write a `{}` marker); the watcher then surfaces it as an untyped table live. -->
		{#if vault.tables.length === 0}
			<Empty.Root class="flex-1 border-0">
				<Empty.Media variant="icon"><LayersIcon /></Empty.Media>
				<Empty.Title>Not a table yet</Empty.Title>
				<Empty.Description>
					{vault.folderName} has no matter.json, so matter shows nothing here. Adopt it to
					create an untyped table from the markdown already inside, or add a matter.json
					yourself.
				</Empty.Description>
				<Empty.Content>
					<Button onclick={adopt} disabled={adopting}>
						<LayersIcon />
						{adopting ? 'Adopting...' : 'Adopt this folder as a table'}
					</Button>
					{#if adoptError}
						<p class="text-sm text-destructive">{adoptError}</p>
					{/if}
				</Empty.Content>
			</Empty.Root>
		{:else}
			<div class="flex min-h-10 items-center gap-1 overflow-x-auto border-b px-2 py-1">
				{#each vault.tables as table (table.folderName)}
					{@const active = activeTable?.folderName === table.folderName}
					<button
						type="button"
						onclick={() =>
							goto(routes.table(table.folderName), {
								// A table switch is a render selection, not navigation: replaceState so
								// each click doesn't stack a history entry, keepFocus/noScroll so the
								// switcher stays put and the grid doesn't jump.
								replaceState: true,
								keepFocus: true,
								noScroll: true,
							})}
						class={[
							'shrink-0 rounded-md px-2.5 py-1 text-sm transition',
							active
								? 'bg-muted font-medium text-foreground'
								: 'text-muted-foreground hover:bg-muted/50',
						]}
					>
						{table.folderName}
					</button>
				{/each}
			</div>
			{#if activeTable}
				{#key activeTable}
					<TablePane {vault} table={activeTable} />
				{/key}
			{/if}
			<IntegrityPanel integrity={vault.integrity} />
		{/if}
	{:catch error}
		<Empty.Root class="flex-1 border-0">
			<Empty.Media variant="icon"><FolderOpenIcon /></Empty.Media>
			<Empty.Title>Couldn't open {vault.folderName}</Empty.Title>
			<Empty.Description>
				{error instanceof Error ? error.message : String(error)}
			</Empty.Description>
		</Empty.Root>
	{/await}
</div>
