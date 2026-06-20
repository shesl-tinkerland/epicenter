import type { RecordingOverlayStatus } from '$lib/recording-overlay/events';
import { webPillLevel } from '$lib/recording-overlay/web-pill.svelte';

/**
 * Browser build of the recording overlay seam.
 *
 * On desktop the pill is a native always-on-top window driven imperatively over
 * IPC. On web the pill is a component (`RecordingPillHost`) mounted in the app
 * layout that reads the dictation lifecycle directly, so there is no status to
 * push: `sync` is a no-op. The shape matches the Tauri implementation so shared
 * callers stay platform agnostic.
 *
 * `reportLevel` still has a job here: it folds the live mic level into the
 * reactive store the web pill reads, the in-page equivalent of the Tauri event
 * that carries the level to the overlay webview.
 */
export const recordingOverlay = {
	sync(_status: RecordingOverlayStatus | null): void {},
	reportLevel(level: number): void {
		webPillLevel.report(level);
	},
};
