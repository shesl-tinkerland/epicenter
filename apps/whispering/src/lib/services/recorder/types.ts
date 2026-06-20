import type { Brand } from 'wellcrafted/brand';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import type { Result } from 'wellcrafted/result';
import type { WhisperingRecordingState } from '$lib/constants/audio';

/**
 * Device acquisition outcome after attempting to connect to a recording device.
 *
 * This type represents the result of device selection during recording startup.
 * All outcomes include the deviceId that was ultimately used for recording. The
 * outcome is returned to the caller as a structured fact; `operations/recording.ts`
 * is the single owner of the user-facing copy that explains a fallback.
 *
 * @example
 * ```typescript
 * // Success: User's preferred device worked
 * { outcome: 'success', deviceId: 'preferred-device-id' as DeviceIdentifier }
 *
 * // Fallback: No device selected, used default
 * {
 *   outcome: 'fallback',
 *   reason: 'no-device-selected',
 *   deviceId: 'default' as DeviceIdentifier
 * }
 *
 * // Fallback: Preferred device unavailable, used alternative
 * {
 *   outcome: 'fallback',
 *   reason: 'preferred-device-unavailable',
 *   deviceId: 'MacBook Pro Microphone' as DeviceIdentifier
 * }
 * ```
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
 * Cast a string to the branded `DeviceIdentifier` type. Use this when adopting
 * device identifiers from external sources (settings, the Navigator API, Rust).
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
	CancelFailed: ({ cause }: { cause: unknown }) => ({
		message: `Failed to cancel recording: ${extractErrorMessage(cause)}`,
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
 * Base parameters shared across manual recorder implementations.
 */
type BaseRecordingParams = {
	selectedDeviceId: DeviceIdentifier | null;
	recordingId: string;
	/**
	 * Optional sink for live mic loudness (raw RMS, ~0 silent to ~0.3 loud
	 * speech), called continuously while recording so the pill can draw a meter.
	 * The navigator recorder taps its MediaStream to drive this; the CPAL recorder
	 * ignores it because Rust emits the level straight to the overlay window.
	 */
	onLevel?: (level: number) => void;
};

/**
 * CPAL (native Rust) recording parameters
 */
export type CpalRecordingParams = BaseRecordingParams & {
	sampleRate: string;
};

/**
 * Navigator (MediaRecorder) recording parameters
 */
export type NavigatorRecordingParams = BaseRecordingParams & {
	bitrateKbps: string;
};

// Imported from the tauri-specta boundary so `RecorderStopResult` is
// structurally identical to what `commands.stopRecording` returns. The Rust
// `RecordingArtifact` struct is the single source of truth; consumers that need
// the type import it from `$lib/tauri/commands` directly.
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
 * A live recording session returned by the recorder implementation that started it.
 *
 * The `RecordingSession` is the unit of lifecycle: it owns its own teardown and
 * exposes per-session state changes.
 *
 * The `subscribe` handler is invoked synchronously with the current state on
 * subscribe (so callers don't have to mirror "I just started" themselves),
 * then again whenever the session transitions, ending with 'IDLE' on
 * stop/cancel.
 */
export type RecordingSession = {
	readonly recordingId: string;
	stop(): Promise<Result<RecorderStopResult, RecorderError>>;
	/**
	 * Cancel the in-flight recording and discard it. Success carries no payload
	 * (a live session can only resolve to "cancelled"); the manual-recorder
	 * wrapper is where the `cancelled` vs `no-recording` distinction is made.
	 */
	cancel(): Promise<Result<void, RecorderError>>;
	subscribe(handler: (state: WhisperingRecordingState) => void): () => void;
};

/**
 * Factory for recording sessions. Services no longer carry mutable
 * start/stop state directly; instead `startRecording` returns a RecordingSession
 * whose methods are bound to the implementation that produced it.
 */
export type RecorderService<RecordingParams extends BaseRecordingParams> = {
	/**
	 * Recover a RecordingSession that may have survived a JS reload.
	 *
	 * CPAL sessions can outlive a JS reload because Rust keeps the stream;
	 * navigator sessions cannot survive a reload and return null.
	 *
	 * Returns the live RecordingSession owned by this implementation, or null if none.
	 */
	resumeActiveSession(): Promise<
		Result<RecordingSession | null, RecorderError>
	>;

	/**
	 * Enumerate available recording devices with their labels and identifiers
	 */
	enumerateDevices(): Promise<Result<Device[], RecorderError>>;

	/**
	 * Start a new recording session, returning the RecordingSession handle along
	 * with the device acquisition outcome. The caller holds the RecordingSession
	 * and uses its `stop`/`cancel`/`subscribe` for the rest of the session.
	 */
	startRecording(params: RecordingParams): Promise<
		Result<
			{
				session: RecordingSession;
				deviceAcquisition: DeviceAcquisitionOutcome;
			},
			RecorderError
		>
	>;
};
