import { InstantString } from '@epicenter/field';
import { IanaTimeZone } from '@epicenter/workspace';
import { extractErrorMessage } from 'wellcrafted/error';
import { goto } from '$app/navigation';
import {
	deliverTranscriptionResult,
	deliverTransformationResult,
	type TranscriptionSource,
} from '$lib/operations/delivery';
import { sound } from '$lib/operations/sound';
import { transcribeAndPersist } from '$lib/operations/transcribe';
import { runTransformation } from '$lib/operations/transform';
import { report } from '$lib/report';
import { services } from '$lib/services';
import type { RecorderStopResult } from '@epicenter/recorder';
import { dictationLifecycle } from '$lib/state/dictation-lifecycle.svelte';
import { recordings } from '$lib/state/recordings.svelte';
import { settings } from '$lib/state/settings.svelte';
import { transformations } from '$lib/state/transformations.svelte';

/**
 * Argument shape for the pipeline. The recorder produces a
 * `RecorderStopResult`; the VAD path and file import path build the
 * equivalent shape with `kind: 'blob'`. `deliverySource` is forwarded
 * straight to delivery, so it shares delivery's `TranscriptionSource` type.
 */
type PipelineInput = {
	source: RecorderStopResult;
	durationMs: number | null;
	deliverySource?: TranscriptionSource;
};

/**
 * Processes a recording through the full pipeline: persist artifact,
 * transcribe by id, then transform.
 *
 * Audio bytes never live in pipeline state. For cpal sources Rust has
 * already written the durable artifact at
 * `<appDataDir>/recordings/{id}.wav` by the time we get here. For blob
 * sources (navigator MediaRecorder, VAD, file import) we persist the
 * bytes through the recordings blob store, then operate on the id.
 *
 * `deliverySource` only shapes the success copy (recording vs file import).
 */
export async function processRecordingPipeline({
	source,
	durationMs,
	deliverySource = 'recording',
}: PipelineInput) {
	const now = InstantString.now();
	const recordingId =
		source.kind === 'artifact' ? source.artifact.id : source.recordingId;

	// A live dictation (not a file import) drives the dictation pill. The
	// recorder is already idle by the time we get here, so the lifecycle hands
	// the pill from `recording` to `transcribing`. File imports have their own
	// surface, so they leave the dictation lifecycle untouched.
	const isDictation = deliverySource === 'recording';
	if (isDictation) dictationLifecycle.markTranscribing();

	recordings.set({
		id: recordingId,
		title: '',
		recordedAt: now,
		recordedAtZone: IanaTimeZone.current(),
		transcript: '',
		duration: durationMs,
		transcription: null,
	});

	if (source.kind === 'blob') {
		const { error: saveError } = await services.blobs.audio.save(
			recordingId,
			source.blob,
		);
		if (saveError) {
			// Transcription reads by id from disk: if the save failed there
			// is nothing to transcribe. Bailing here surfaces the real
			// failure instead of the misleading "no recording artifact
			// found" the transcribe path would emit on the empty directory.
			recordings.update(recordingId, {
				transcription: {
					status: 'failed',
					completedAt: InstantString.now(),
					error: extractErrorMessage(saveError),
				},
			});
			if (isDictation) {
				// No toast in the dictation path: the failure goes to the notification
				// (when unfocused) and the recordings row.
				dictationLifecycle.markFailed({
					tier: 'transcription',
					error: saveError,
				});
			} else {
				report.error({
					title: 'Failed to save recording',
					description:
						'We could not write the recording bytes; transcription cannot continue.',
					cause: saveError,
				});
			}
			return;
		}
	}

	// File import has no pill, so it keeps a progress toast; the dictation path is
	// driven by the lifecycle markers above (the pill), with no toast.
	const transcribeLoading = isDictation
		? null
		: report.loading({
				title: '📋 Transcribing...',
				description: 'Your recording is being transcribed...',
			});

	const { data: transcribedText, error: transcribeError } =
		await transcribeAndPersist(recordingId);

	if (transcribeError) {
		if (isDictation) {
			dictationLifecycle.markFailed({
				tier: 'transcription',
				error: transcribeError,
			});
		} else {
			transcribeLoading?.reject({ cause: transcribeError });
		}
		return;
	}

	sound.playSoundIfEnabled('transcriptionComplete');
	const { outcome: transcriptDelivery, notice: transcribeNotice } =
		await deliverTranscriptionResult({
			text: transcribedText,
			source: deliverySource,
		});
	if (isDictation) {
		// The transcript is the dictation receipt; the transformation below, if
		// any, runs as a background enhancement (logged in transformation runs)
		// rather than reopening the pill. Every reach is a success (the transcript
		// is saved), so this is always `delivered`; the reach decides whether the
		// pill flashes (clean `output`) or persists (a reduced `clipboard`).
		dictationLifecycle.markDelivered(transcriptDelivery.reach);
	} else {
		transcribeLoading?.resolve(transcribeNotice);
	}

	const transformationId = settings.get('transformation.selectedId');
	if (!transformationId) return;

	const transformation = transformations.get(transformationId);
	if (!transformation) {
		settings.set('transformation.selectedId', null);
		report.info({
			title: 'No matching transformation found',
			description:
				'No matching transformation found. Please select a different transformation.',
			action: {
				label: 'Select a different transformation',
				onClick: () => goto('/transformations'),
			},
		});
		return;
	}

	const transformLoading = isDictation
		? null
		: report.loading({
				title: '🔄 Running transformation...',
				description:
					'Applying your selected transformation to the transcribed text...',
			});

	const { data: transformedText, error: transformError } =
		await runTransformation({
			input: transcribedText,
			transformation,
			recordingId,
		});
	if (transformError) {
		// The transformation failed, but the transcript was already delivered, so
		// the dictation is not a failure: the durable transformation run records
		// the error. File import surfaces it on its toast.
		transformLoading?.reject({ cause: transformError });
		return;
	}

	sound.playSoundIfEnabled('transformationComplete');

	const { notice: transformNotice } = await deliverTransformationResult({
		text: transformedText,
		recordingId,
	});
	transformLoading?.resolve(transformNotice);
}
