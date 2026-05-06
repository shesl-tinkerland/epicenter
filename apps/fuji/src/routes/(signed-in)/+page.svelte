<script lang="ts">
	import { getSignedInSession } from '$lib/signed-in-session';
	import EntriesTable from './components/EntriesTable.svelte';
	import EntriesTimeline from './components/EntriesTimeline.svelte';
	import { viewState } from './state/view.svelte';

	const { entries } = getSignedInSession();
</script>

{#if viewState.viewMode === 'table'}
	<EntriesTable entries={entries.active} />
{:else}
	<EntriesTimeline entries={entries.active} />
{/if}
