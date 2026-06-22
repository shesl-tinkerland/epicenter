<!--
	The result of a finished recording: a copyable, expandable transcript preview
	and a player for the captured audio. The home recorder and the first-run "try
	it" step both render this, so the two cannot drift.

	The audio renders whenever the clip exists, independent of the transcript, so a
	silent or not-yet-transcribed recording still plays back. The playback URL is
	owned here: the blob store caches it per id, and it is revoked on teardown.
-->
<script lang="ts">
	import { createQuery } from '@tanstack/svelte-query';
	import { onDestroy } from 'svelte';
	import TranscriptDialog from '$lib/components/copyable/TranscriptDialog.svelte';
	import { rpc } from '$lib/rpc';
	import { services } from '$lib/services';
	import { viewTransition } from '$lib/utils/viewTransitions';

	let {
		recordingId,
		transcript,
		rows = 1,
		onDelete,
	}: {
		recordingId: string;
		transcript: string;
		/** Visible rows of the transcript preview before it scrolls/expands. */
		rows?: number;
		/** When provided, the transcript dialog shows a delete action. */
		onDelete?: () => void;
	} = $props();

	const audioQuery = createQuery(() => ({
		...rpc.audio.getPlaybackUrl(() => recordingId).options,
		enabled: !!recordingId,
	}));
	onDestroy(() => {
		if (recordingId) services.blobs.audio.revokeUrl(recordingId);
	});
</script>

<div class="flex w-full flex-col gap-2">
	<TranscriptDialog
		{recordingId}
		{transcript}
		{rows}
		disabled={!transcript.trim()}
		{onDelete}
	/>
	{#if audioQuery.data}
		<audio
			style:view-transition-name={viewTransition.recording(recordingId).audio}
			src={audioQuery.data}
			controls
			class="h-8 w-full"
		></audio>
	{/if}
</div>
