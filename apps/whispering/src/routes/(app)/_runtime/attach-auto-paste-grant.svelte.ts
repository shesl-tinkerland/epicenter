import { tauri } from '#platform/tauri';
import { settings } from '$lib/state/settings.svelte';

/**
 * Mirror the auto-paste settings into the Rust tap supervisor. Auto-paste writes
 * at the cursor via a synthetic Cmd/Ctrl+V, which needs the same macOS
 * Accessibility grant the tap does. Telling the supervisor whether either paste
 * mode is on keeps it holding the tap to track that grant (and surfacing the
 * notice if missing) even when no Fn binding is set. Desktop only.
 *
 * The `$effect` is owned by the mounting component's lifecycle, so it disposes
 * with the runtime; the returned cleanup is a no-op.
 */
export function attachAutoPasteGrant() {
	if (!tauri) return () => {};
	const t = tauri;

	$effect(() => {
		const autoPaste =
			settings.get('output.transcription.cursor') ||
			settings.get('output.transformation.cursor');
		void t.globalShortcuts.setAutoPasteEnabled(autoPaste);
	});

	return () => {};
}
