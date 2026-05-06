<script lang="ts">
	import { page } from '$app/state';
	import EntriesTable from '../../components/EntriesTable.svelte';
	import EntriesTimeline from '../../components/EntriesTimeline.svelte';
	import { getSignedInSession } from '$lib/signed-in-session';
	import { viewState } from '../../state/view.svelte';

	const { entries } = getSignedInSession();
	const tagParam = $derived(decodeURIComponent(page.params.tag ?? ''));
	const filteredEntries = $derived(
		entries.active.filter((e) => e.tags.includes(tagParam)),
	);
</script>

{#if viewState.viewMode === 'table'}
	<EntriesTable entries={filteredEntries} title={tagParam} />
{:else}
	<EntriesTimeline entries={filteredEntries} title={tagParam} />
{/if}
