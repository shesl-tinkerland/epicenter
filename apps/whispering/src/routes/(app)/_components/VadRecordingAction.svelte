<script lang="ts">
	import { viewTransition } from '$lib/utils/viewTransitions';
	import CapturePipeline from './CapturePipeline.svelte';
	import { createVadRecordingController } from './vad-recording-controller.svelte';
	import RecordingActionCard from './RecordingActionCard.svelte';

	const vadRec = createVadRecordingController();
</script>

<RecordingActionCard
	controller={vadRec}
	iconViewTransitionName={viewTransition.recordingMode('vad')}
>
	{#snippet footer()}
		<CapturePipeline surface="vad" />
	{/snippet}
</RecordingActionCard>
