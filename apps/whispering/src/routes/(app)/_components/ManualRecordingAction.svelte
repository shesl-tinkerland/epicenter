<script lang="ts">
	import { viewTransition } from '$lib/utils/viewTransitions';
	import CapturePipeline from './CapturePipeline.svelte';
	import { createManualRecordingController } from './manual-recording-controller.svelte';
	import RecordingActionCard from './RecordingActionCard.svelte';

	const rec = createManualRecordingController();
</script>

<RecordingActionCard
	controller={rec}
	iconViewTransitionName={viewTransition.recordingMode('manual')}
>
	{#snippet footer()}
		<CapturePipeline surface="manual" />
	{/snippet}
</RecordingActionCard>
