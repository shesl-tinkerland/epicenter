import { MicVAD, utils } from '@ricky0123/vad-web';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { defineKeys } from 'wellcrafted/query';
import { Err, Ok, tryAsync, trySync } from 'wellcrafted/result';
import type { VadState } from '$lib/constants/audio';
import { defineQuery } from '$lib/rpc/client';
import {
	cleanupRecordingStream,
	enumerateDevices,
	getRecordingStream,
} from '$lib/services/device-stream';
import { asDeviceIdentifier } from '$lib/services/recorder/types';
import { deviceConfig } from '$lib/state/device-config.svelte';

const VadRecorderError = defineErrors({
	EnumerateDevicesFailed: ({ cause }: { cause: unknown }) => ({
		message: `Failed to enumerate devices: ${extractErrorMessage(cause)}`,
		cause,
	}),
	AlreadyActive: () => ({
		message: 'Stop the current session before starting a new one.',
	}),
	InitializeFailed: ({ cause }: { cause: unknown }) => ({
		message:
			'Voice activity detection could not be started. Your microphone may be in use by another application.',
		cause,
	}),
	StartFailed: ({ cause }: { cause: unknown }) => ({
		message: `Failed to start Voice Activity Detector. ${extractErrorMessage(cause)}`,
		cause,
	}),
	StopFailed: ({ cause }: { cause: unknown }) => ({
		message: `Failed to stop Voice Activity Detector. ${extractErrorMessage(cause)}`,
		cause,
	}),
});
type VadRecorderError = InferErrors<typeof VadRecorderError>;

export const vadKeys = defineKeys({
	devices: ['vad', 'devices'],
});

/**
 * Creates a Voice Activity Detection (VAD) recorder with reactive state.
 *
 * This module provides voice activity detection using the @ricky0123/vad-web library.
 * State is managed with Svelte's $state rune for automatic reactivity.
 *
 * Usage:
 * - Access state reactively: `vadRecorder.state` (triggers effects when changed)
 * - Start listening: `await vadRecorder.startActiveListening({ onSpeechStart, onSpeechEnd })`
 * - Stop listening: `await vadRecorder.stopActiveListening()`
 * - Enumerate devices: `createQuery(() => vadRecorder.enumerateDevices.options)`
 */
/**
 * Active VAD session, or null when idle. Collapses the previous
 * `_session` + `_state` pair into a single reactive field so the
 * invariant `vad/stream exist iff state !== 'IDLE'` is type-enforced:
 * there is no way to spell a non-idle state without the underlying
 * MicVAD and MediaStream that produced it.
 */
type VadSession = {
	state: 'LISTENING' | 'SPEECH_DETECTED';
	vad: MicVAD;
	stream: MediaStream;
};

function createVadRecorder() {
	let _session = $state<VadSession | null>(null);

	return {
		/**
		 * Current VAD state. Reactive - reading this in an $effect will
		 * cause the effect to re-run when the state changes.
		 */
		get state(): VadState {
			return _session?.state ?? 'IDLE';
		},

		/**
		 * Enumerate available audio input devices.
		 *
		 * Usage:
		 * - With createQuery: `createQuery(() => vadRecorder.enumerateDevices.options)`
		 */
		enumerateDevices: defineQuery({
			queryKey: vadKeys.devices,
			queryFn: async () => {
				const { data, error } = await enumerateDevices();
				if (error)
					return VadRecorderError.EnumerateDevicesFailed({ cause: error });
				return Ok(data);
			},
		}),

		/**
		 * Start voice activity detection.
		 * Updates `state` reactively as detection progresses.
		 */
		async startActiveListening({
			onSpeechStart,
			onSpeechEnd,
			onVADMisfire,
		}: {
			onSpeechStart: () => void;
			onSpeechEnd: (blob: Blob) => void;
			onVADMisfire?: () => void;
		}) {
			// Prevent starting if already active
			if (_session) return VadRecorderError.AlreadyActive();

			// Get device ID from settings
			const configuredDeviceId = deviceConfig.get(
				'recording.navigator.deviceId',
			);
			const deviceId = configuredDeviceId
				? asDeviceIdentifier(configuredDeviceId)
				: null;

			// Get validated stream with device fallback
			const { data: streamResult, error: streamError } =
				await getRecordingStream({
					selectedDeviceId: deviceId,
				});

			if (streamError) return Err(streamError);

			const { stream, deviceOutcome } = streamResult;

			// Create VAD with the validated stream
			const { data: newVad, error: initializeVadError } = await tryAsync({
				try: () =>
					MicVAD.new({
						stream,
						submitUserSpeechOnPause: true,
						onSpeechStart: () => {
							if (_session) _session.state = 'SPEECH_DETECTED';
							onSpeechStart();
						},
						onSpeechEnd: (audio) => {
							if (_session) _session.state = 'LISTENING';
							const wavBuffer = utils.encodeWAV(audio);
							const blob = new Blob([wavBuffer], { type: 'audio/wav' });
							onSpeechEnd(blob);
						},
						onVADMisfire: () => {
							if (_session) _session.state = 'LISTENING';
							onVADMisfire?.();
						},
						model: 'v5',
					}),
				catch: (error) => VadRecorderError.InitializeFailed({ cause: error }),
			});

			if (initializeVadError) {
				// Clean up stream if VAD initialization fails
				cleanupRecordingStream(stream);
				return Err(initializeVadError);
			}

			// Start listening
			const { error: startError } = trySync({
				try: () => newVad.start(),
				catch: (error) => VadRecorderError.StartFailed({ cause: error }),
			});

			if (startError) {
				// Clean up everything on start error
				trySync({
					try: () => newVad.destroy(),
					catch: () => Ok(undefined),
				});
				cleanupRecordingStream(stream);
				return Err(startError);
			}

			_session = { state: 'LISTENING', vad: newVad, stream };
			return Ok(deviceOutcome);
		},

		/**
		 * Stop voice activity detection and clean up resources.
		 * Sets `state` back to 'IDLE'.
		 */
		async stopActiveListening() {
			if (!_session) return Ok(undefined);

			const { vad, stream } = _session;
			const { error: destroyError } = trySync({
				try: () => vad.destroy(),
				catch: (error) => VadRecorderError.StopFailed({ cause: error }),
			});

			// Always clean up, even if dispose had an error
			_session = null;
			cleanupRecordingStream(stream);

			if (destroyError) return Err(destroyError);
			return Ok(undefined);
		},
	};
}

export const vadRecorder = createVadRecorder();
