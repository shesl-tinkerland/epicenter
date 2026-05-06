<script lang="ts">
	import { page } from '$app/state';
	import EntriesTable from '../../components/EntriesTable.svelte';
	import EntriesTimeline from '../../components/EntriesTimeline.svelte';
	import { getSignedInSession } from '$lib/signed-in-session';
	import { viewState } from '../../state/view.svelte';

	const { entries } = getSignedInSession();
	const typeParam = $derived(decodeURIComponent(page.params.type ?? ''));
	const filteredEntries = $derived(
		entries.active.filter((e) => e.type.includes(typeParam)),
	);
</script>

{#if viewState.viewMode === 'table'}
	<EntriesTable entries={filteredEntries} title={typeParam} />
{:else}
	<EntriesTimeline entries={filteredEntries} title={typeParam} />
{/if}
