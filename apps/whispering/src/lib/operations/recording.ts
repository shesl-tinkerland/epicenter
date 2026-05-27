import { nanoid } from 'nanoid/non-secure';
import { goto } from '$app/navigation';
import { analytics } from '$lib/operations/analytics';
import { processRecordingPipeline } from '$lib/operations/pipeline';
import { sound } from '$lib/operations/sound';
import { log, type Notice, report } from '$lib/report';
import type { DeviceAcquisitionOutcome } from '$lib/services/recorder/types';
import { deviceConfig } from '$lib/state/device-config.svelte';
import { manualRecorder } from '$lib/state/manual-recorder.svelte';
import { settings } from '$lib/state/settings.svelte';
import { vadRecorder } from '$lib/state/vad-recorder.svelte';

function handleDeviceAcquisitionOutcome(
	outcome: DeviceAcquisitionOutcome,
	successTitle: string,
	successDescription: string,
	persist: (deviceId: string) => void,
): Notice {
	if (outcome.outcome === 'success') {
		return {
			title: successTitle,
			description: successDescription,
		};
	}

	persist(outcome.deviceId);
	switch (outcome.reason) {
		case 'no-device-selected':
			return {
				title: '🎙️ Switched to available microphone',
				description:
					'No microphone was selected, so we automatically connected to an available one. You can update your selection in settings.',
				action: {
					label: 'Open Settings',
					onClick: () => goto('/settings/recording'),
				},
			};
		case 'preferred-device-unavailable':
			return {
				title: '🎙️ Switched to different microphone',
				description:
					"Your previously selected microphone wasn't found, so we automatically connected to an available one.",
				action: {
					label: 'Open Settings',
					onClick: () => goto('/settings/recording'),
				},
			};
	}
}

export async function startManualRecording() {
	settings.set('recording.mode', 'manual');

	const loading = report.loading({
		title: '🎙️ Preparing to record...',
		description: 'Setting up your recording environment...',
	});

	const { data: outcome, error } = await manualRecorder.startRecording();

	if (error) {
		loading.reject({ cause: error });
		return;
	}

	loading.resolve(
		handleDeviceAcquisitionOutcome(
			outcome,
			'🎙️ Whispering is recording...',
			'Speak now and stop recording when done',
			(deviceId) => {
				const method = deviceConfig.get('recording.method');
				deviceConfig.set(`recording.${method}.deviceId`, deviceId);
			},
		),
	);

	log.info('Recording started');
	sound.playSoundIfEnabled('manual-start');
}

export async function stopManualRecording() {
	const loading = report.loading({
		title: '⏸️ Stopping recording...',
		description: 'Finalizing your audio capture...',
	});

	const { data: source, error } = await manualRecorder.stopRecording();

	if (error) {
		loading.reject({ cause: error });
		return;
	}

	const durationMs =
		source.kind === 'artifact' ? source.artifact.durationMs : source.durationMs;
	const byteLength =
		source.kind === 'artifact' ? source.artifact.byteLength : source.blob.size;

	loading.resolve({
		title: '🎙️ Recording stopped',
		description: 'Your recording has been saved',
	});
	log.info('Recording stopped');
	sound.playSoundIfEnabled('manual-stop');

	analytics.logEvent({
		type: 'manual_recording_completed',
		blob_size: byteLength,
		duration: durationMs ?? undefined,
	});

	await processRecordingPipeline({
		source,
		durationMs,
	});
}

export async function toggleManualRecording() {
	if (manualRecorder.state === 'RECORDING') {
		return await stopManualRecording();
	}
	return await startManualRecording();
}

export async function cancelManualRecording() {
	const loading = report.loading({
		title: '⏸️ Canceling recording...',
		description: 'Cleaning up recording session...',
	});

	const { data, error } = await manualRecorder.cancelRecording();

	if (error) {
		loading.reject({ cause: error });
		return;
	}

	switch (data.status) {
		case 'no-recording': {
			loading.resolve({
				title: 'No active recording',
				description: 'There is no recording in progress to cancel.',
			});
			break;
		}
		case 'cancelled': {
			loading.resolve({
				title: '✅ All Done!',
				description: 'Recording cancelled successfully',
			});
			sound.playSoundIfEnabled('manual-cancel');
			log.info('Recording cancelled');
			break;
		}
	}
}

export async function startVadRecording() {
	settings.set('recording.mode', 'vad');

	log.info('Starting voice activated capture');
	const loading = report.loading({
		title: '🎙️ Starting voice activated capture',
		description: 'Your voice activated capture is starting...',
	});

	const { data: outcome, error } = await vadRecorder.startActiveListening({
		onSpeechStart: () => {
			report.success({
				title: '🎙️ Speech started',
				description: 'Recording started. Speak clearly and loudly.',
			});
		},
		onSpeechEnd: async (blob) => {
			report.success({
				title: '🎙️ Voice activated speech captured',
				description: 'Your voice activated speech has been captured.',
			});
			log.info('Voice activated speech captured');
			sound.playSoundIfEnabled('vad-capture');

			analytics.logEvent({
				type: 'vad_recording_completed',
				blob_size: blob.size,
			});

			await processRecordingPipeline({
				source: {
					kind: 'blob',
					blob,
					recordingId: nanoid(),
					durationMs: null,
				},
				durationMs: null,
			});
		},
	});

	if (error) {
		loading.reject({ cause: error });
		return;
	}

	loading.resolve(
		handleDeviceAcquisitionOutcome(
			outcome,
			'🎙️ Voice activated capture started',
			'Your voice activated capture has been started.',
			(deviceId) => deviceConfig.set('recording.navigator.deviceId', deviceId),
		),
	);

	sound.playSoundIfEnabled('vad-start');
}

export async function stopVadRecording() {
	log.info('Stopping voice activated capture');
	const loading = report.loading({
		title: '⏸️ Stopping voice activated capture...',
		description: 'Finalizing your voice activated capture...',
	});
	const { error } = await vadRecorder.stopActiveListening();
	if (error) {
		loading.reject({ cause: error });
		return;
	}
	loading.resolve({
		title: '🎙️ Voice activated capture stopped',
		description: 'Your voice activated capture has been stopped.',
	});
	sound.playSoundIfEnabled('vad-stop');
}

export async function toggleVadRecording() {
	if (
		vadRecorder.state === 'LISTENING' ||
		vadRecorder.state === 'SPEECH_DETECTED'
	) {
		return await stopVadRecording();
	}
	return await startVadRecording();
}
