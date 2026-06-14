import { InstantString } from '@epicenter/field';
import { IanaTimeZone } from '@epicenter/workspace';
import { extractErrorMessage } from 'wellcrafted/error';
import { goto } from '$app/navigation';
import {
	deliverTranscriptionResult,
	deliverTransformationResult,
} from '$lib/operations/delivery';
import { sound } from '$lib/operations/sound';
import { transcribeAndPersist } from '$lib/operations/transcribe';
import { runTransformation } from '$lib/operations/transform';
import { report } from '$lib/report';
import { services } from '$lib/services';
import type { RecorderStopResult } from '$lib/services/recorder/types';
import { recordings } from '$lib/state/recordings.svelte';
import { settings } from '$lib/state/settings.svelte';
import { transformations } from '$lib/state/transformations.svelte';

type DeliverySource = 'recording' | 'upload';

/**
 * Argument shape for the pipeline. The recorder produces a
 * `RecorderStopResult`; the VAD path and file-upload path build the
 * equivalent shape with `kind: 'blob'`.
 */
type PipelineInput = {
	source: RecorderStopResult;
	durationMs: number | null;
	deliverySource?: DeliverySource;
};

/**
 * Processes a recording through the full pipeline: persist artifact,
 * transcribe by id, then transform.
 *
 * Audio bytes never live in pipeline state. For cpal sources Rust has
 * already written the durable artifact at
 * `<appDataDir>/recordings/{id}.wav` by the time we get here. For blob
 * sources (navigator MediaRecorder, VAD, file upload) we persist the
 * bytes through the recordings blob store, then operate on the id.
 */
export async function processRecordingPipeline({
	source,
	durationMs,
	deliverySource = 'recording',
}: PipelineInput) {
	const now = InstantString.now();
	const recordingId =
		source.kind === 'artifact' ? source.artifact.id : source.recordingId;

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
			report.error({
				title: 'Failed to save recording',
				description:
					'We could not write the recording bytes; transcription cannot continue.',
				cause: saveError,
			});
			return;
		}
	}

	const transcribeLoading = report.loading({
		title: '📋 Transcribing...',
		description: 'Your recording is being transcribed...',
	});

	const { data: transcribedText, error: transcribeError } =
		await transcribeAndPersist(recordingId);

	if (transcribeError) {
		transcribeLoading.reject({ cause: transcribeError });
		return;
	}

	sound.playSoundIfEnabled('transcriptionComplete');
	const transcribeNotice = await deliverTranscriptionResult({
		text: transcribedText,
		source: deliverySource,
	});
	transcribeLoading.resolve(transcribeNotice);

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

	const transformLoading = report.loading({
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
		transformLoading.reject({ cause: transformError });
		return;
	}

	sound.playSoundIfEnabled('transformationComplete');

	const transformNotice = await deliverTransformationResult({
		text: transformedText,
	});
	transformLoading.resolve(transformNotice);
}
