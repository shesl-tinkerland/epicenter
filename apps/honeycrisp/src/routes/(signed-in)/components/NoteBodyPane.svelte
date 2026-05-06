<script lang="ts">
	import { fromDisposableCache } from '@epicenter/svelte';
	import { PaneSpinner } from '@epicenter/svelte/pane-spinner';
	import HoneycripEditor from '$lib/editor/Editor.svelte';
	import { getHoneycrispState } from '../state';
	import { getSignedIn } from '../signed-in';

	const signedIn = getSignedIn();
	const { notesState } = getHoneycrispState();

	let { noteId }: { noteId: string } = $props();

	const doc = fromDisposableCache(signedIn.honeycrisp.noteBodyDocs, () => noteId);
</script>

{#await doc.current.idb.whenLoaded}
	<PaneSpinner class="h-full !flex-none" />
{:then _}
	<HoneycripEditor
		yxmlfragment={doc.current.body.binding}
		onContentChange={(change) => notesState.updateNoteContent(change)}
	/>
{/await}
