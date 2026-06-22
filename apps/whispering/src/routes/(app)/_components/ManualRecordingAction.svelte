<script lang="ts">
	import type { Snippet } from 'svelte';
	import { viewTransition } from '$lib/utils/viewTransitions';
	import { createManualRecordingController } from './manual-recording-controller.svelte';
	import RecordingActionCard from './RecordingActionCard.svelte';

	let {
		pipeline,
	}: {
		pipeline: Snippet;
	} = $props();

	const rec = createManualRecordingController();
</script>

<RecordingActionCard
	controller={rec}
	footer={pipeline}
	iconViewTransitionName={viewTransition.recordingMode('manual')}
/>
