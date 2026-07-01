/**
 * Recording state types. These are plain unions: the states are never validated
 * at runtime, only used as compile-time types.
 */

// The recorder lifecycle and VAD state now live in `@epicenter/recorder`; alias
// the recorder state to the app's existing name so in-app consumers keep their
// import.
export type {
	RecordingState as WhisperingRecordingState,
	VadState,
} from '@epicenter/recorder';
