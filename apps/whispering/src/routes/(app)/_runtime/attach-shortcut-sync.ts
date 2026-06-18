import { shortcuts } from '#platform/shortcuts';
import { tauri } from '#platform/tauri';

/**
 * Register the current shortcut bindings on whichever backend this build uses.
 * `shortcuts.sync()` binds the Tier-0 chords on the desktop plugin (their own
 * callbacks dispatch into the command layer, so they need no separate listener)
 * and the Tier-1 Fn/modifier-only holds on the tap; the browser backend binds
 * the same bindings as in-app keydown. Cleanup unregisters the desktop plugin
 * chords. The in-app keydown listener and the tap's trigger channel are each
 * owned by their own runtime owner (`attachLocalShortcutListener`,
 * `attachGlobalShortcutTriggers`).
 */
export function attachShortcutSync() {
	void shortcuts.sync();
	return () => {
		void tauri?.keyboard.unregisterChords();
	};
}
