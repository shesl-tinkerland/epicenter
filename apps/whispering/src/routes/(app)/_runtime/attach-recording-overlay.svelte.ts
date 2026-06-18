import type { UnlistenFn } from '@tauri-apps/api/event';
import { recordingOverlay } from '#platform/recording-overlay';
import { tauri } from '#platform/tauri';
import {
	cancelRecording,
	stopManualRecording,
	stopVadRecording,
} from '$lib/operations/recording';
import {
	type RecordingOverlayStatus,
	recordingOverlayAction,
} from '$lib/recording-overlay/events';
import { manualRecorder } from '$lib/state/manual-recorder.svelte';
import { polishHud } from '$lib/state/polish-hud.svelte';
import { vadRecorder } from '$lib/state/vad-recorder.svelte';

export function attachRecordingOverlay() {
	let unlistenAction: UnlistenFn | undefined;

	const overlayStatus = $derived.by((): RecordingOverlayStatus | null => {
		if (manualRecorder.state === 'RECORDING')
			return { trigger: 'manual', state: 'RECORDING' };
		if (
			vadRecorder.state === 'LISTENING' ||
			vadRecorder.state === 'SPEECH_DETECTED'
		)
			return { trigger: 'vad', state: vadRecorder.state };
		// The Polish pass runs after the recorder is idle, so the pill stays on
		// the same spot through recording -> polishing -> gone.
		if (polishHud.active) return { phase: 'polishing' };
		return null;
	});

	$effect(() => {
		recordingOverlay.sync(overlayStatus);
	});

	if (tauri) {
		void (async () => {
			unlistenAction = await recordingOverlayAction.listen((event) => {
				if (!overlayStatus) return;
				if ('phase' in overlayStatus) {
					if (event.payload === 'ship-raw') polishHud.shipRaw();
					return;
				}
				if (overlayStatus.trigger === 'manual') {
					if (event.payload === 'cancel') void cancelRecording();
					else void stopManualRecording();
					return;
				}
				if (event.payload === 'stop') void stopVadRecording();
			});
		})();
	}

	return () => {
		unlistenAction?.();
	};
}
