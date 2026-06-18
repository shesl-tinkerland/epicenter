/**
 * Recording state types. These are plain unions: the states are never validated
 * at runtime, only used as compile-time types.
 */
export type WhisperingRecordingState = 'IDLE' | 'RECORDING';

export type VadState = 'IDLE' | 'LISTENING' | 'SPEECH_DETECTED';
