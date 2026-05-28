<script lang="ts">
	import * as Empty from '@epicenter/ui/empty';
	import FileXIcon from '@lucide/svelte/icons/file-x';
	import { page } from '$app/state';
	import { requireFuji } from '$lib/session';
	import { asEntryId } from '../../../../../fuji.workspace';
	import EntryEditor from '../../components/EntryEditor.svelte';

	const fuji = requireFuji();
	const entryId = $derived(page.params.id ? asEntryId(page.params.id) : null);
	const entry = $derived(entryId ? (fuji.entries.get(entryId) ?? null) : null);
</script>

<main class="flex h-full flex-1 flex-col overflow-hidden">
	{#if !entry}
		<Empty.Root class="flex-1">
			<Empty.Media>
				<FileXIcon class="size-8 text-muted-foreground" />
			</Empty.Media>
			<Empty.Title>Entry not found</Empty.Title>
			<Empty.Description
				>This entry may have been deleted or the URL is invalid.</Empty.Description
			>
		</Empty.Root>
	{:else}
		{#key entryId}
			<EntryEditor {entry} />
		{/key}
	{/if}
</main>
