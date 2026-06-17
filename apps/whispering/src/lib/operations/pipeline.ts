import { InstantString } from '@epicenter/field';
import { IanaTimeZone } from '@epicenter/workspace';
import { extractErrorMessage } from 'wellcrafted/error';
import { deliverTranscriptionResult } from '$lib/operations/delivery';
import { sound } from '$lib/operations/sound';
import { transcribeAndPersist } from '$lib/operations/transcribe';
import { report } from '$lib/report';
import { services } from '$lib/services';
import type { RecorderStopResult } from '$lib/services/recorder/types';
import { recordings } from '$lib/state/recordings.svelte';

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

	// TODO(wave-2): run Cleanup here (dictionary -> auto-cleanup) over the raw
	// transcript and deliver the cleaned text, keeping the raw stored underneath
	// on the recording. This replaces the old `transformation.selectedId`
	// auto-run, which is gone: the automatic path is always Cleanup, never a
	// picked Format. See ADR 0013 and the Wave 2 sequencing in
	// apps/whispering/specs/20260616T230000-cleanup-and-portable-formats-greenfield.md.
}
