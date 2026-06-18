import { tauri } from '#platform/tauri';
import { manualRecorder } from '$lib/state/manual-recorder.svelte';

/**
 * Keep the tray/dock icon in sync with the manual recorder's state. Desktop
 * only; the `$effect` is owned by the mounting component, so it disposes with
 * the runtime and the returned cleanup is a no-op.
 */
export function attachSyncIconWithRecorderState() {
	if (!tauri) return () => {};
	const t = tauri;

	$effect(() => {
		void t.tray.setIcon({ icon: manualRecorder.state });
	});

	return () => {};
}
