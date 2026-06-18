<script lang="ts">
	import { createMutation } from '@tanstack/svelte-query';
	import type { Snippet } from 'svelte';
	import { MANUAL_RECORDING_BUTTON } from '$lib/constants/audio';
	import {
		startManualRecording,
		stopManualRecording,
	} from '$lib/operations/recording';
	import { manualRecorder } from '$lib/state/manual-recorder.svelte';
	import { getRecordingShortcutLabel } from '$lib/utils/recording-shortcut';
	import { viewTransition } from '$lib/utils/viewTransitions';
	import RecordingActionCard from './RecordingActionCard.svelte';

	let {
		pipeline,
	}: {
		pipeline: Snippet;
	} = $props();

	// Manual stop and start are separate mutations on purpose: stopManualRecording
	// awaits the full transcription pipeline, so its pending window outlives the
	// RECORDING state (the recorder resets to IDLE the moment the mic stops, while
	// transcription is still running). Deriving direction from manualRecorder.state
	// alone would mislabel that post-stop window as "starting". VAD can use a single
	// toggle because its pipeline runs in a separate speech-end callback, not in stop.
	const startMutation = createMutation(() => ({
		mutationFn: startManualRecording,
	}));
	const stopMutation = createMutation(() => ({
		mutationFn: stopManualRecording,
	}));

	const isStarting = $derived(startMutation.isPending);
	const isStopping = $derived(stopMutation.isPending);
	const isPending = $derived(isStarting || isStopping);
	const isRecording = $derived(manualRecorder.state === 'RECORDING');
	const shortcutLabel = $derived(getRecordingShortcutLabel('manual'));
	const button = $derived(MANUAL_RECORDING_BUTTON[manualRecorder.state]);
	const label = $derived(button.label);
	const idleDescription = $derived(
		shortcutLabel ? 'Click or press shortcut' : 'Click to record',
	);
	const description = $derived.by(() => {
		if (isStarting) return 'Opening microphone input';
		if (isStopping) return 'Stopping recording';
		if (isRecording) return 'Click again to stop';
		return idleDescription;
	});
	const tooltip = $derived.by(() => {
		if (isStarting) return 'Preparing recording controls';
		if (isStopping) return 'Stopping recording';
		return label;
	});

	function handleClick() {
		if (isRecording) {
			stopMutation.mutate();
		} else {
			startMutation.mutate();
		}
	}
</script>

<RecordingActionCard
	active={isRecording}
	{description}
	footer={isRecording ? undefined : pipeline}
	icon={button.Icon}
	iconViewTransitionName={viewTransition.recordingMode('manual')}
	{label}
	pending={isPending}
	{shortcutLabel}
	{tooltip}
	onclick={handleClick}
/>
