import {
	cancelRecording,
	stopManualRecording,
	stopVadRecording,
} from '$lib/operations/recording';
import type { RecordingOverlayAction } from '$lib/recording-overlay/events';
import { dictationLifecycle } from '$lib/state/dictation-lifecycle.svelte';

/**
 * The pill's control gestures, mapped to recorder operations in one place. Both
 * pill mounts route through here so the gesture-to-operation rules live once: the
 * web host calls this directly, and the Tauri main window calls it from the
 * overlay's action IPC. The pill component itself stays presentational.
 *
 * Stop and cancel act only on a live capture. VAD has no cancel (its pill shows
 * no cancel button), so a stray cancel during a VAD session is a no-op. There is
 * no retry gesture: a failed dictation is retried from its recordings row.
 */
export function dispatchPillAction(action: RecordingOverlayAction): void {
	const { capture } = dictationLifecycle.current;
	if (capture.kind !== 'recording') return;
	if (capture.trigger === 'manual') {
		if (action === 'cancel') void cancelRecording();
		else void stopManualRecording();
		return;
	}
	if (action === 'stop') void stopVadRecording();
}
