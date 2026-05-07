<script lang="ts">
	import { fromDisposableCache } from '@epicenter/svelte';
	import { Loading } from '@epicenter/ui/loading';
	import HoneycripEditor from '$lib/editor/Editor.svelte';
	import { getSignedInSession } from '$lib/session.svelte';
	import type { NoteId } from '../honeycrisp/workspace';

	const signedIn = getSignedInSession();

	let { noteId }: { noteId: NoteId } = $props();

	const doc = fromDisposableCache(
		signedIn.honeycrisp.noteBodyDocs,
		() => noteId,
	);
</script>

{#await doc.current.idb.whenLoaded}
	<Loading class="h-full" />
{:then _}
	<HoneycripEditor
		yxmlfragment={doc.current.body.binding}
		onContentChange={(change) => signedIn.state.notes.updateContent(noteId, change)}
	/>
{/await}
