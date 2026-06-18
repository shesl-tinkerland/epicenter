import { tauri } from '#platform/tauri';
import { outputWritesToCursor } from '$lib/operations/delivery';

/**
 * Push the auto-paste intent (one of the Rust `TapIntent` reasons to hold the
 * tap) whenever delivery writes at the cursor. Cursor delivery is a synthetic
 * Cmd/Ctrl+V, which needs the same macOS Accessibility grant the tap does, so
 * when any output scope writes to the cursor the supervisor holds the tap to
 * track that grant (and surface the notice if missing) even when no Fn binding
 * is set. `outputWritesToCursor` is the single source of truth shared with
 * `delivery.ts`; reading it inside the `$effect` keeps the push live as the
 * output toggles change. Desktop only.
 *
 * The `$effect` is owned by the mounting component's lifecycle, so it disposes
 * with the runtime; the returned cleanup is a no-op.
 */
export function attachAutoPasteIntent() {
	if (!tauri) return () => {};
	const t = tauri;

	$effect(() => {
		void t.keyboard.setAutoPasteEnabled(outputWritesToCursor());
	});

	return () => {};
}
