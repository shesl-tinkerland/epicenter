import type { VadState, WhisperingRecordingState } from '$lib/constants/audio';
import { defineWindowEvent, defineWindowSignal } from '$lib/window-events';

/**
 * Event contract for the recording overlay window.
 *
 * The overlay lives in its own webview and therefore cannot read the recorder
 * state modules directly. The main window pushes the current status to the
 * overlay, and the overlay pushes user actions back. The channels below carry
 * that traffic; each binds its name to its payload so emitter and listener stay
 * in sync (see `defineWindowEvent`).
 *
 * This module imports no Tauri runtime APIs beyond the typed-channel helper, so
 * it stays loadable on web (where the overlay never exists) and from the overlay
 * page itself.
 */

/**
 * What the overlay should display. Only the non-idle states are
 * representable: an idle recorder hides the overlay rather than emitting a
 * status, so there is no `IDLE` variant to render.
 *
 * The overlay spans the whole dictation gesture, not just recording: after the
 * recorder stops, the `polishing` mode keeps the same floating pill on screen
 * while the AI Polish pass runs, so the user sees one continuous surface
 * (recording -> polishing -> gone) in the spot they are already watching. See
 * ADR 0029.
 */
export type RecordingOverlayStatus =
	| { trigger: 'manual'; state: Extract<WhisperingRecordingState, 'RECORDING'> }
	| { trigger: 'vad'; state: Exclude<VadState, 'IDLE'> }
	| { phase: 'polishing' };

/**
 * The control the user invoked from the overlay. `ship-raw` cancels the
 * in-flight Polish pass and delivers the raw transcript immediately.
 */
export type RecordingOverlayAction = 'stop' | 'cancel' | 'ship-raw';

/** main -> overlay: what to display, or that the overlay is shown. */
export const recordingOverlayStatus = defineWindowEvent<RecordingOverlayStatus>(
	'recording-overlay:status',
);

/** overlay -> main: the user clicked stop or cancel. */
export const recordingOverlayAction = defineWindowEvent<RecordingOverlayAction>(
	'recording-overlay:action',
);

/**
 * overlay -> main: the overlay mounted and its listener is live, so the main
 * window should re-send the latest status. Without this handshake the first
 * status can be emitted before the overlay's listener is attached and get lost.
 */
export const recordingOverlayReady = defineWindowSignal(
	'recording-overlay:ready',
);

/**
 * Live mic level (main -> overlay), a raw RMS amplitude (~0 silent, ~0.3 loud
 * speech). The overlay applies the perceptual gain and smoothing so both
 * producers, VAD frames in JS and the CPAL worker in Rust, can stay dumb and
 * just report RMS. The name stays the bare string `mic-level` because the Rust
 * recorder emits the same channel (see recorder.rs `MIC_LEVEL_EVENT`).
 */
export const recordingOverlayMicLevel = defineWindowEvent<number>('mic-level');
