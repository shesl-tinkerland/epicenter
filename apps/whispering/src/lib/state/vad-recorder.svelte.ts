import { MicVAD, utils } from '@ricky0123/vad-web';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { defineKeys } from 'wellcrafted/query';
import { Err, Ok, tryAsync } from 'wellcrafted/result';
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

const vadKeys = defineKeys({
	devices: ['vad', 'devices'],
});

const VAD_ASSET_PATH = '/vad/';

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

/**
 * Root-mean-square amplitude of one audio frame (samples in -1..1), a cheap
 * proxy for "how loud is the mic right now". Fed to the recording overlay's
 * level meter. Computed from the frame the VAD already hands us, so there is
 * no second audio graph.
 */
function computeFrameRms(frame: Float32Array): number {
	if (frame.length === 0) return 0;
	let sumOfSquares = 0;
	for (const sample of frame) sumOfSquares += sample * sample;
	return Math.sqrt(sumOfSquares / frame.length);
}

function createVadRecorder() {
	let _session = $state<VadSession | null>(null);
	let _starting = false;

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
			onLevel,
		}: {
			onSpeechStart: () => void;
			onSpeechEnd: (blob: Blob) => void;
			onVADMisfire?: () => void;
			/**
			 * Called after each processed frame with the frame's RMS amplitude.
			 * Drives the recording overlay's live level meter.
			 */
			onLevel?: (level: number) => void;
		}) {
			// `_session` is assigned after async setup, so `_starting` closes the
			// duplicate-start window before a live session exists.
			if (_session || _starting) return VadRecorderError.AlreadyActive();
			_starting = true;

			try {
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
							// The recorder owns the stream lifecycle: it is acquired via
							// getRecordingStream and released by stopActiveListening's
							// cleanupRecordingStream below. MicVAD only borrows it, so
							// pause is a no-op and resume hands back the same live stream.
							// (Resume is never reached today: this app starts once and
							// destroys on stop, but keeping it live keeps the three stream
							// hooks mutually consistent rather than handing back a stopped
							// stream.)
							getStream: async () => stream,
							pauseStream: async () => {},
							resumeStream: async () => stream,
							startOnLoad: false,
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
							onFrameProcessed: (_probabilities, frame) => {
								if (onLevel) onLevel(computeFrameRms(frame));
							},
							model: 'v5',
							baseAssetPath: VAD_ASSET_PATH,
							// vad-web sets `ort.env.wasm.wasmPaths` to this base path before
							// calling ortConfig, so the default onnxruntime-web build resolves
							// /vad/ort-wasm-simd-threaded.{mjs,wasm} on its own.
							onnxWASMBasePath: VAD_ASSET_PATH,
							ortConfig: (ort) => {
								ort.env.logLevel = 'error';
							},
						}),
					catch: (error) => VadRecorderError.InitializeFailed({ cause: error }),
				});

				if (initializeVadError) {
					// Clean up stream if VAD initialization fails
					cleanupRecordingStream(stream);
					return Err(initializeVadError);
				}

				// Start listening
				const { error: startError } = await tryAsync({
					try: async () => newVad.start(),
					catch: (error) => VadRecorderError.StartFailed({ cause: error }),
				});

				if (startError) {
					// Clean up everything on start error
					await tryAsync({
						try: async () => newVad.destroy(),
						catch: () => Ok(undefined),
					});
					cleanupRecordingStream(stream);
					return Err(startError);
				}

				_session = { state: 'LISTENING', vad: newVad, stream };
				return Ok(deviceOutcome);
			} finally {
				_starting = false;
			}
		},

		/**
		 * Stop voice activity detection and clean up resources.
		 * Sets `state` back to 'IDLE'.
		 */
		async stopActiveListening() {
			if (!_session)
				return Ok({
					status: 'idle' as const,
				});

			const { vad, stream } = _session;
			const { error: destroyError } = await tryAsync({
				try: async () => vad.destroy(),
				catch: (error) => VadRecorderError.StopFailed({ cause: error }),
			});

			// Always clean up, even if dispose had an error
			_session = null;
			cleanupRecordingStream(stream);

			if (destroyError) return Err(destroyError);
			return Ok({
				status: 'stopped' as const,
			});
		},
	};
}

export const vadRecorder = createVadRecorder();
