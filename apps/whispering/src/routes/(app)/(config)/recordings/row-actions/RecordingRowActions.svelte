<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { CopyButton } from '@epicenter/ui/copy-button';
	import { Skeleton } from '@epicenter/ui/skeleton';
	import { Spinner } from '@epicenter/ui/spinner';
	import DownloadIcon from '@lucide/svelte/icons/download';
	import EllipsisIcon from '@lucide/svelte/icons/ellipsis';
	import FileStackIcon from '@lucide/svelte/icons/file-stack';
	import PlayIcon from '@lucide/svelte/icons/play';
	import RepeatIcon from '@lucide/svelte/icons/repeat';
	import RotateCcwIcon from '@lucide/svelte/icons/rotate-ccw';
	import TrashIcon from '@lucide/svelte/icons/trash-2';
	import { createMutation } from '@tanstack/svelte-query';
	import type { AnyTaggedError } from 'wellcrafted/error';
	import { deliverTranscriptionResult } from '$lib/operations/delivery';
	import { deleteRecordingsWithConfirmation } from '$lib/operations/recordings';
	import { sound } from '$lib/operations/sound';
	import { report } from '$lib/report';
	import { rpc } from '$lib/rpc';
	import { recordings } from '$lib/state/recordings.svelte';
	import { transformationRuns } from '$lib/state/transformation-runs.svelte';
	import { createCopyFn } from '$lib/utils/createCopyFn';
	import { viewTransition } from '$lib/utils/viewTransitions';
	import EditRecordingModal from './EditRecordingModal.svelte';
	import TransformationPicker from './TransformationPicker.svelte';
	import ViewTransformationRunsDialog from './ViewTransformationRunsDialog.svelte';

	const transcribeRecording = createMutation(
		() => rpc.transcription.transcribeRecording.options,
	);

	const downloadRecording = createMutation(
		() => rpc.download.downloadRecording.options,
	);

	let { recordingId }: { recordingId: string } = $props();

	const latestRun = $derived(
		transformationRuns.getLatestByRecordingId(recordingId),
	);

	const recording = $derived(recordings.get(recordingId));

	// Liveness is the in-flight mutation, not a stored field: while this row's
	// transcription is pending it reads as transcribing, otherwise the stored
	// outcome (completed/failed) or its absence (unprocessed) decides the state.
	// A discriminated union, so the failed case carries its error directly.
	const transcriptionState = $derived.by(() => {
		if (transcribeRecording.isPending) return { status: 'transcribing' } as const;
		return recording?.transcription ?? ({ status: 'unprocessed' } as const);
	});

	const transcriptionTooltip = $derived.by(() => {
		switch (transcriptionState.status) {
			case 'unprocessed':
				return 'Start transcribing this recording';
			case 'transcribing':
				return 'Currently transcribing...';
			case 'completed':
				return 'Retry transcription';
			case 'failed':
				return `Transcription failed: ${transcriptionState.error}. Click to retry`;
		}
	});
</script>

<div class="flex items-center gap-1">
	{#if !recording}
		<Skeleton class="size-8" />
		<Skeleton class="size-8" />
		<Skeleton class="size-8" />
		<Skeleton class="size-8" />
		<Skeleton class="size-8" />
	{:else}
		<Button
			tooltip={transcriptionTooltip}
			onclick={() => {
				const loading = report.loading({
					title: 'Transcribing...',
					description: 'Your recording is being transcribed...',
				});
				transcribeRecording.mutate(recording, {
					onError: (error) => {
						loading.reject({
							cause: error as AnyTaggedError,
							title: 'Failed to transcribe recording',
							description: 'Your recording could not be transcribed.',
						});
					},
					onSuccess: async (transcribedText) => {
						sound.playSoundIfEnabled('transcriptionComplete');

						const notice = await deliverTranscriptionResult({
							text: transcribedText,
						});
						loading.resolve(notice);
					},
				});
			}}
			variant="ghost"
			size="icon"
		>
			{#if transcriptionState.status === 'unprocessed'}
				<PlayIcon class="size-4" />
			{:else if transcriptionState.status === 'transcribing'}
				<EllipsisIcon class="size-4" />
			{:else if transcriptionState.status === 'completed'}
				<RepeatIcon class="size-4 text-green-500" />
			{:else if transcriptionState.status === 'failed'}
				<RotateCcwIcon class="size-4 text-red-500" />
			{/if}
		</Button>

		<TransformationPicker recordingId={recording.id} />

		<EditRecordingModal {recording} />

		<CopyButton
			text={recording.transcript}
			copyFn={createCopyFn('transcript')}
			style="view-transition-name: {viewTransition.recording(recordingId)
				.transcript}"
		/>

		{#if latestRun?.result?.status === 'completed'}
			<CopyButton
				text={latestRun.result.output}
				copyFn={createCopyFn('latest transformation run output')}
				style="view-transition-name: {viewTransition.recording(recordingId)
					.transformationOutput}"
			>
				{#snippet icon()}
					<FileStackIcon class="size-4" />
				{/snippet}
			</CopyButton>
		{/if}

		<ViewTransformationRunsDialog {recordingId} />

		<Button
			tooltip="Download recording"
			onclick={() =>
				downloadRecording.mutate(recording, {
					onError: (error) => {
						report.error({
							cause: error as AnyTaggedError,
							title: 'Failed to download recording!',
							description: 'Your recording could not be downloaded.',
						});
					},
					onSuccess: () => {
						report.success({
							title: 'Recording downloaded!',
							description: 'Your recording has been downloaded.',
						});
					},
				})}
			variant="ghost"
			size="icon"
		>
			{#if downloadRecording.isPending}
				<Spinner />
			{:else}
				<DownloadIcon class="size-4" />
			{/if}
		</Button>

		<Button
			tooltip="Delete recording"
			onclick={() => deleteRecordingsWithConfirmation(recording)}
			variant="ghost"
			size="icon"
		>
			<TrashIcon class="size-4" />
		</Button>
	{/if}
</div>
