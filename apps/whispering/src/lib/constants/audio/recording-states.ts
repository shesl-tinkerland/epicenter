/**
 * Recording state types. These are plain unions: the states are never validated
 * at runtime, only used as compile-time types.
 */

// The recorder lifecycle state now lives in `@epicenter/recorder`; alias it to
// the app's existing name so in-app consumers keep their import.
export type { RecordingState as WhisperingRecordingState } from '@epicenter/recorder';

export type VadState = 'IDLE' | 'LISTENING' | 'SPEECH_DETECTED';
