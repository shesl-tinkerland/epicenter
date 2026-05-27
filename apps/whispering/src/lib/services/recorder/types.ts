import type { Brand } from 'wellcrafted/brand';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import type { Result } from 'wellcrafted/result';
import type {
	CancelRecordingResult,
	WhisperingRecordingState,
} from '$lib/constants/audio';

/**
 * Device acquisition outcome after attempting to connect to a recording device.
 *
 * Structured fact returned from `startRecording`. The operation layer maps it
 * to user-facing toast copy; services never emit copy themselves.
 */
export type DeviceAcquisitionOutcome =
	| {
			outcome: 'success';
			deviceId: DeviceIdentifier;
	  }
	| {
			outcome: 'fallback';
			reason: 'no-device-selected' | 'preferred-device-unavailable';
			deviceId: DeviceIdentifier;
	  };

/**
 * Platform-agnostic device identifier for audio recording devices.
 *
 * On Web (Navigator API):
 *   - This is the unique `deviceId` from MediaDeviceInfo (e.g., "default" or a GUID)
 *   - NOT the device label. We use the actual deviceId for uniqueness
 *
 * On Desktop (CPAL):
 *   - This is the device name as a string (e.g., "MacBook Pro Microphone")
 *   - The name serves as both identifier and label
 *
 * While these represent different concepts on each platform, they serve the same
 * purpose: uniquely identifying a recording device for selection and persistence.
 * The branded type ensures type safety and makes the dual nature explicit.
 *
 * @example
 * // Web: Stores the deviceId (unique identifier, NOT the label)
 * const deviceIdentifier: DeviceIdentifier = "8a7b9c..." as DeviceIdentifier;
 *
 * // Desktop: Stores the device name (which is both ID and label)
 * const deviceIdentifier: DeviceIdentifier = "MacBook Pro Microphone" as DeviceIdentifier;
 */
export type DeviceIdentifier = string & Brand<'DeviceIdentifier'>;

/**
 * Represents an audio recording device with both a unique identifier and human-readable label.
 *
 * On Web (Navigator API):
 *   - `id`: The unique deviceId from MediaDeviceInfo (e.g., "default" or a GUID)
 *   - `label`: The human-readable device label (e.g., "Built-in Microphone")
 *
 * On Desktop (CPAL):
 *   - `id`: The device name (e.g., "MacBook Pro Microphone")
 *   - `label`: The same device name (identical to id for desktop)
 *
 * This separation allows for better UX (showing readable names) while maintaining
 * stable identifiers for settings persistence.
 *
 * @example
 * // Web device
 * const device: Device = {
 *   id: "8a7b9c..." as DeviceIdentifier,
 *   label: "Blue Yeti USB Microphone"
 * };
 *
 * // Desktop device
 * const device: Device = {
 *   id: "MacBook Pro Microphone" as DeviceIdentifier,
 *   label: "MacBook Pro Microphone"
 * };
 */
export type Device = {
	id: DeviceIdentifier;
	label: string;
};

/**
 * Type guard to convert a string to DeviceIdentifier
 * Use this when receiving device identifiers from external sources
 * @see DeviceIdentifier
 */
export function asDeviceIdentifier(value: string): DeviceIdentifier {
	return value as DeviceIdentifier;
}

export const RecorderError = defineErrors({
	EnumerateDevices: ({ cause }: { cause: unknown }) => ({
		message: `Failed to enumerate recording devices: ${extractErrorMessage(cause)}`,
		cause,
	}),
	NoDevice: ({ message }: { message: string }) => ({
		message,
	}),
	MicrophonePermissionDenied: ({ cause }: { cause?: unknown } = {}) => ({
		message:
			'Microphone access was denied. Please grant microphone permission in your system or browser settings and try again.',
		cause,
	}),
	NoInputDevice: ({ cause }: { cause?: unknown } = {}) => ({
		message:
			"We couldn't find any microphone to record from. Please connect a microphone and try again.",
		cause,
	}),
	AlreadyRecording: () => ({
		message:
			'A recording is already in progress. Please stop the current recording before starting a new one.',
	}),
	InitFailed: ({ cause }: { cause: unknown }) => ({
		message: `Failed to initialize the audio recorder: ${extractErrorMessage(cause)}`,
		cause,
	}),
	StartFailed: ({ cause }: { cause: unknown }) => ({
		message: `Unable to start recording: ${extractErrorMessage(cause)}`,
		cause,
	}),
	StopFailed: ({ cause }: { cause: unknown }) => ({
		message: `Failed to stop recording: ${extractErrorMessage(cause)}`,
		cause,
	}),
	StreamAcquisition: ({ cause }: { cause: unknown }) => ({
		message: `Failed to acquire recording stream: ${extractErrorMessage(cause)}`,
		cause,
	}),
	GetStateFailed: ({ cause }: { cause: unknown }) => ({
		message: `Failed to get recorder state: ${extractErrorMessage(cause)}`,
		cause,
	}),
});
export type RecorderError = InferErrors<typeof RecorderError>;

/**
 * Base parameters shared across all methods
 */
type BaseRecordingParams = {
	selectedDeviceId: DeviceIdentifier | null;
	recordingId: string;
};

/**
 * CPAL (native Rust) recording parameters
 */
export type CpalRecordingParams = BaseRecordingParams & {
	method: 'cpal';
	sampleRate: string;
};

/**
 * Navigator (MediaRecorder) recording parameters
 */
export type NavigatorRecordingParams = BaseRecordingParams & {
	method: 'navigator';
	bitrateKbps: string;
};

/**
 * Re-exported from the tauri-specta boundary so this module's
 * `RecorderStopResult` is structurally identical to what `commands.stopRecording`
 * returns. The Rust `RecordingArtifact` struct is the single source of truth;
 * the boundary file generates the TS shape (`mimeType: string` since cpal is
 * currently the only producer but a future navigator-on-Tauri save could emit
 * other mimes).
 */
export type { RecordingArtifact } from '$lib/tauri/commands';

import type { RecordingArtifact } from '$lib/tauri/commands';

/**
 * Output of `RecordingSession.stop()`. One of two physical shapes:
 *
 * - `kind: 'artifact'`: cpal produced a durable WAV on disk; the handle
 *   is the canonical reference for transcribe/upload/delete. JS does not
 *   touch the bytes itself.
 * - `kind: 'blob'`: navigator (browser MediaRecorder) returned encoded
 *   container bytes (webm/opus, mp4/AAC) the JS side holds in memory.
 *   The pipeline persists it through the recordings blob store so the
 *   id-addressed Rust commands work on it too. There is intentionally
 *   no `Float32Array` arm: raw PCM never exists as a general front-end
 *   value.
 *
 * `durationMs` lives on whichever arm naturally carries it (the cpal
 * artifact stat, the navigator wall-clock measurement). VAD and file
 * uploads have no notion of duration at the recorder boundary; they
 * synthesize a `kind: 'blob'` result from outside the recorder and pass
 * `null` for duration at the pipeline boundary.
 */
export type RecorderStopResult =
	| { kind: 'artifact'; artifact: RecordingArtifact }
	| {
			kind: 'blob';
			blob: Blob;
			recordingId: string;
			durationMs: number | null;
	  };

/**
 * Discriminated union for recording parameters based on method
 */
export type StartRecordingParams =
	| CpalRecordingParams
	| NavigatorRecordingParams;

/**
 * A live recording session bound to the backend that started it.
 *
 * The `RecordingSession` is the unit of lifecycle: it knows its own backend, owns
 * its own teardown, and exposes per-session state changes. Toggling
 * `recording.method` after construction has no effect on an in-flight
 * RecordingSession, which is what fixes the swap-mid-recording leak.
 *
 * The `subscribe` handler is invoked synchronously with the current state on
 * subscribe (so callers don't have to mirror "I just started" themselves),
 * then again whenever the session transitions, ending with 'IDLE' on
 * stop/cancel.
 */
export type RecordingSession = {
	readonly recordingId: string;
	readonly backend: 'navigator' | 'cpal';
	stop(): Promise<Result<RecorderStopResult, RecorderError>>;
	cancel(): Promise<Result<CancelRecordingResult, RecorderError>>;
	subscribe(handler: (state: WhisperingRecordingState) => void): () => void;
};

/**
 * Factory for recording sessions. Services no longer carry mutable
 * start/stop state directly; instead `startRecording` returns a RecordingSession
 * whose methods are bound to the backend that produced it.
 *
 * Rehydration after a JS reload is intentionally not part of this contract:
 * only CPAL can survive a reload (the Rust process keeps the stream alive),
 * so the rehydration probe lives on `CpalRecorderServiceLive` directly. The
 * navigator backend cannot rehydrate, so pretending it could in this
 * interface would be a lie. See `manual-recorder.svelte.ts` bootstrap.
 */
export type RecorderService = {
	/**
	 * Enumerate available recording devices with their labels and identifiers
	 */
	enumerateDevices(): Promise<Result<Device[], RecorderError>>;

	/**
	 * Start a new recording session, returning the RecordingSession handle along
	 * with the device acquisition outcome. The caller holds the RecordingSession
	 * and uses its `stop`/`cancel`/`subscribe` for the rest of the session.
	 */
	startRecording(
		params: StartRecordingParams,
	): Promise<
		Result<
			{
				session: RecordingSession;
				deviceAcquisition: DeviceAcquisitionOutcome;
			},
			RecorderError
		>
	>;
};

/**
 * CPAL-only extension of `RecorderService`. CPAL sessions can outlive a JS
 * reload because the Rust process keeps the stream alive, so the CPAL
 * service exposes a probe that the manual recorder calls during bootstrap
 * to rehydrate. Navigator cannot rehydrate, so this method is not on the
 * base interface.
 */
export type CpalRecorderService = RecorderService & {
	getActiveRecording(): Promise<Result<RecordingSession | null, RecorderError>>;
};
