<script lang="ts">
	import * as Alert from '@epicenter/ui/alert';
	import * as Empty from '@epicenter/ui/empty';
	import { Loading } from '@epicenter/ui/loading';
	import FolderOpenIcon from '@lucide/svelte/icons/folder-open';
	import TableGrid from '$lib/components/TableGrid.svelte';
	import type { TableAssessment } from '$lib/core/integrity';
	import type { TableHandle } from '$lib/table.svelte';
	import { createWhereFilter } from '$lib/where-filter.svelte';

	// One table of the active vault. The Vault constructs and disposes the table (it owns the
	// watcher lifetime); this pane just renders it. VaultShell keys this component on the active
	// table, so switching tables remounts the pane with a fresh filter and its own effect.
	// `assessment` is this table's slice of the vault's live integrity, carrying the cross-table
	// reference verdicts the grid colors its chips by.
	let {
		table,
		assessment,
	}: { table: TableHandle; assessment?: TableAssessment } = $props();

	// One WHERE filter per pane: it takes the table at construction and owns its own effect
	// (re-querying on a clause or mirror change, cancelling stale runs). The remount-per-table
	// keying is what makes "take the table at construction" safe.
	// svelte-ignore state_referenced_locally - VaultShell keys this pane on the active table, so it remounts (not re-renders) when the table changes; capturing the construction-time table is the intent.
	const filter = createWhereFilter(table);
</script>

<div class="flex min-h-0 flex-1 flex-col">
	{#if table.status.kind === 'loading'}
		<Loading class="flex-1" label="Loading {table.folderName}" />
	{:else if table.status.kind === 'error'}
		<Empty.Root class="flex-1 border-0">
			<Empty.Media variant="icon"><FolderOpenIcon /></Empty.Media>
			<Empty.Title>Couldn't watch {table.folderName}</Empty.Title>
			<Empty.Description>{table.status.message}</Empty.Description>
		</Empty.Root>
	{:else}
		{#if table.writeError}
			<Alert.Root variant="destructive" class="rounded-none border-x-0 border-t-0 py-2">
				<Alert.Description class="text-xs">
					Couldn't save: {table.writeError}
				</Alert.Description>
			</Alert.Root>
		{/if}
		<TableGrid {table} {filter} {assessment} />
	{/if}
</div>
