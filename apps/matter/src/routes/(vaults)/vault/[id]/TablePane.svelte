<script lang="ts">
	import * as Alert from '@epicenter/ui/alert';
	import * as Empty from '@epicenter/ui/empty';
	import { Loading } from '@epicenter/ui/loading';
	import FolderOpenIcon from '@lucide/svelte/icons/folder-open';
	import TableGrid from '$lib/components/TableGrid.svelte';
	import type { TableHandle } from '$lib/table.svelte';
	import type { VaultHandle } from '$lib/vault.svelte';
	import { createWhereFilter } from '$lib/where-filter.svelte';

	// One table of the active vault. The Vault constructs and disposes the table (it owns the
	// watcher lifetime) and owns the shared `.matter` mirror the filter queries; this pane just
	// renders it. VaultShell keys this component on the active table, so switching tables remounts
	// the pane with a fresh filter and its own effect.
	let { vault, table }: { vault: VaultHandle; table: TableHandle } = $props();

	// This table's slice of the vault-wide integrity, selected from the one live model the
	// IntegrityPanel also reads, so the grid's reference chips and the panel's findings agree by
	// construction. Derived here, next to the grid that consumes it, rather than threaded from the
	// shell: the pane already holds the vault, so the slice is a pure selector with no prop hop.
	const assessment = $derived(
		vault.integrity.tables.find((t) => t.name === table.folderName),
	);

	// One WHERE filter per pane: it queries the vault's mirror for this table and owns its own effect
	// (re-querying on a clause or mirror change, cancelling stale runs). The remount-per-table keying
	// is what makes capturing this table's name at construction safe.
	// svelte-ignore state_referenced_locally - VaultShell keys this pane on the active table, so it remounts (not re-renders) when the table changes; capturing the construction-time table is the intent.
	const filter = createWhereFilter(vault.mirror, () => table.folderName);
</script>

<div class="flex min-h-0 flex-1 flex-col">
	{#await table.whenReady}
		<Loading class="flex-1" label="Loading {table.folderName}" />
	{:then _}
		{#if table.writeError}
			<Alert.Root variant="destructive" class="rounded-none border-x-0 border-t-0 py-2">
				<Alert.Description class="text-xs">
					Couldn't save: {table.writeError}
				</Alert.Description>
			</Alert.Root>
		{/if}
		<TableGrid {table} {filter} {assessment} />
	{:catch error}
		<Empty.Root class="flex-1 border-0">
			<Empty.Media variant="icon"><FolderOpenIcon /></Empty.Media>
			<Empty.Title>Couldn't watch {table.folderName}</Empty.Title>
			<Empty.Description>
				{error instanceof Error ? error.message : String(error)}
			</Empty.Description>
		</Empty.Root>
	{/await}
</div>
