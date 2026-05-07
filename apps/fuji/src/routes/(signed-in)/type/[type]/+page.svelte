<script lang="ts">
	import { page } from '$app/state';
	import { getSignedInSession } from '$lib/session.svelte';
	import EntriesTable from '../../components/EntriesTable.svelte';
	import EntriesTimeline from '../../components/EntriesTimeline.svelte';
	import { viewState } from '../../state/view.svelte';

	const signedIn = getSignedInSession();
	const typeParam = $derived(decodeURIComponent(page.params.type ?? ''));
	const filteredEntries = $derived(
		signedIn.entries.active.filter((e) => e.type.includes(typeParam)),
	);
</script>

{#if viewState.viewMode === 'table'}
	<EntriesTable entries={filteredEntries} title={typeParam} />
{:else}
	<EntriesTimeline entries={filteredEntries} title={typeParam} />
{/if}
