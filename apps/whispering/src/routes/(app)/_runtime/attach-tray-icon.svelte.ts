import { tauri } from '#platform/tauri';
import { dictationLifecycle } from '$lib/state/dictation-lifecycle.svelte';

/**
 * Project the dictation lifecycle onto the tray icon: the menubar is one more
 * surface of the single lifecycle the pill renders (ADR-0039), not a second,
 * unrelated read. The tray is a coarse ambient cue with two icons, so it
 * reflects only whether a capture is live; the in-flight and terminal phases
 * (transcribing, delivered, failed) stay the pill's job. Reading the lifecycle
 * rather than the manual recorder alone is what makes the tray follow a VAD
 * session too, instead of sitting on the idle icon while the pill lights up.
 *
 * Desktop only; the `$effect` is owned by the mounting component, so it disposes
 * with the runtime and the returned cleanup is a no-op.
 */
export function attachTrayIcon() {
	if (!tauri) return () => {};
	const t = tauri;

	$effect(() => {
		const icon =
			dictationLifecycle.current.capture.kind === 'recording'
				? 'RECORDING'
				: 'IDLE';
		void t.tray.setIcon({ icon });
	});

	return () => {};
}
