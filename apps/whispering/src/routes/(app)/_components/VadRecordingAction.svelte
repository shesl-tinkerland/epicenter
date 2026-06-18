<script lang="ts">
	import { createMutation } from '@tanstack/svelte-query';
	import type { Snippet } from 'svelte';
	import { VAD_RECORDING_BUTTON } from '$lib/constants/audio';
	import { toggleVadRecording } from '$lib/operations/recording';
	import { vadRecorder } from '$lib/state/vad-recorder.svelte';
	import { getRecordingShortcutLabel } from '$lib/utils/recording-shortcut';
	import { viewTransition } from '$lib/utils/viewTransitions';
	import RecordingActionCard from './RecordingActionCard.svelte';

	let {
		pipeline,
	}: {
		pipeline: Snippet;
	} = $props();

	const toggleMutation = createMutation(() => ({
		mutationFn: toggleVadRecording,
	}));

	const isListening = $derived(vadRecorder.state !== 'IDLE');
	const isSpeechDetected = $derived(vadRecorder.state === 'SPEECH_DETECTED');
	const button = $derived(VAD_RECORDING_BUTTON[vadRecorder.state]);
	const shortcutLabel = $derived(getRecordingShortcutLabel('vad'));
	const label = $derived(button.label);
	const description = $derived.by(() => {
		if (toggleMutation.isPending) return 'Updating voice activation';
		if (isSpeechDetected) return 'Speech detected';
		if (isListening) return 'Listening for speech';
		return 'Listen for speech';
	});
	const tooltip = $derived.by(() => {
		if (toggleMutation.isPending) return 'Updating voice activated session';
		if (isListening) return 'Stop voice activated session';
		return 'Start voice activated session';
	});
</script>

<RecordingActionCard
	active={isListening}
	{description}
	footer={isListening ? undefined : pipeline}
	icon={button.Icon}
	iconViewTransitionName={viewTransition.recordingMode('vad')}
	{label}
	pending={toggleMutation.isPending}
	{shortcutLabel}
	{tooltip}
	onclick={() => toggleMutation.mutate()}
/>
