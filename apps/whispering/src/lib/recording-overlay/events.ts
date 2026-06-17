import type { VadState, WhisperingRecordingState } from '$lib/constants/audio';

/**
 * Event contract for the recording overlay window.
 *
 * The overlay lives in its own webview and therefore cannot read the recorder
 * state modules directly. The main window pushes the current status to the
 * overlay, and the overlay pushes user actions back. Three Tauri event
 * channels carry that traffic:
 *
 * - `status` (main -> overlay): what to display, or that the overlay is shown.
 * - `action` (overlay -> main): the user clicked stop or cancel.
 * - `ready`  (overlay -> main): the overlay mounted and its listener is live,
 *   so the main window should re-send the latest status. Without this
 *   handshake the first status can be emitted before the overlay's listener
 *   is attached and get lost.
 *
 * This module imports no Tauri APIs so it stays loadable on web (where the
 * overlay never exists) and from the overlay page itself.
 */
export const RECORDING_OVERLAY_STATUS = 'recording-overlay:status';
export const RECORDING_OVERLAY_ACTION = 'recording-overlay:action';
export const RECORDING_OVERLAY_READY = 'recording-overlay:ready';
/**
 * Clicking the pill body (anywhere that is not a control) asks the main window
 * to come to the front. Kept separate from `action` so it never routes through
 * the recorder: stop/cancel only stop/cancel, and revealing the window is its
 * own gesture.
 */
export const RECORDING_OVERLAY_FOCUS_MAIN = 'recording-overlay:focus-main';
/**
 * Live mic level (main -> overlay), a raw RMS amplitude (~0 silent, ~0.3 loud
 * speech). The overlay applies the perceptual gain and smoothing so both
 * producers, VAD frames in JS and the CPAL worker in Rust, can stay dumb and
 * just report RMS. Kept as the bare string `mic-level` because the Rust
 * recorder emits the same channel (see recorder.rs `MIC_LEVEL_EVENT`).
 */
export const RECORDING_OVERLAY_MIC_LEVEL = 'mic-level';

/**
 * What the overlay should display. Only the non-idle states are
 * representable: an idle recorder hides the overlay rather than emitting a
 * status, so there is no `IDLE` variant to render.
 *
 * The overlay spans the whole dictation gesture, not just recording: after the
 * recorder stops, the `polishing` mode keeps the same floating pill on screen
 * while the AI Polish pass runs, so the user sees one continuous surface
 * (recording -> polishing -> gone) in the spot they are already watching. See
 * ADR 0013.
 */
export type RecordingOverlayStatus =
	| { mode: 'manual'; state: Extract<WhisperingRecordingState, 'RECORDING'> }
	| { mode: 'vad'; state: Exclude<VadState, 'IDLE'> }
	| { mode: 'polishing' };

/**
 * The control the user invoked from the overlay. `ship-raw` cancels the
 * in-flight Polish pass and delivers the raw transcript immediately.
 */
export type RecordingOverlayAction = 'stop' | 'cancel' | 'ship-raw';
