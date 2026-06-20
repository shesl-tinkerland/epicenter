import type { UnlistenFn } from '@tauri-apps/api/event';
import { recordingOverlay } from '#platform/recording-overlay';
import { tauri } from '#platform/tauri';
import { recordingOverlayAction } from '$lib/recording-overlay/events';
import { dispatchPillAction } from '$lib/recording-overlay/pill-actions';
import { projectLifecycleToStatus } from '$lib/recording-overlay/projection';
import { dictationLifecycle } from '$lib/state/dictation-lifecycle.svelte';

export function attachRecordingOverlay() {
	let unlistenAction: UnlistenFn | undefined;

	const overlayStatus = $derived(
		projectLifecycleToStatus(dictationLifecycle.current),
	);

	$effect(() => {
		recordingOverlay.sync(overlayStatus);
	});

	if (tauri) {
		void (async () => {
			unlistenAction = await recordingOverlayAction.listen((event) =>
				dispatchPillAction(event.payload),
			);
		})();
	}

	return () => {
		unlistenAction?.();
	};
}
