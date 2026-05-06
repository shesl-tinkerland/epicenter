<script lang="ts">
	import { useCacheHandle } from '@epicenter/svelte';
	import { Loading } from '@epicenter/ui/loading';
	import HoneycripEditor from '$lib/editor/Editor.svelte';
	import { getSignedInSession } from '$lib/session.svelte';

	const signedIn = getSignedInSession();
	const { notesState } = signedIn.state;

	let { noteId }: { noteId: string } = $props();

	const doc = useCacheHandle(signedIn.honeycrisp.noteBodyDocs, () => noteId);
</script>

{#await doc.current.idb.whenLoaded}
	<Loading class="h-full" />
{:then _}
	<HoneycripEditor
		yxmlfragment={doc.current.body.binding}
		onContentChange={(change) => notesState.updateNoteContent(change)}
	/>
{/await}
