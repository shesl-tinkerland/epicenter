import { shortcuts } from '#platform/shortcuts';
import { tauri } from '#platform/tauri';

export function attachGlobalShortcuts() {
	let cleanupTapListener: (() => void) | undefined;
	let destroyed = false;

	// `sync` registers the current bindings: Tier-0 chords on the plugin (whose
	// own callbacks dispatch into the command layer, so they need no separate
	// listener) and Tier-1 Fn/modifier-only holds on the tap. The browser backend
	// binds in-app keydown the same way.
	void shortcuts.sync();

	// The Tier-1 tap emits trigger events on a channel; subscribe so its holds
	// dispatch into the command layer too. (The plugin chords do not flow through
	// here; their handlers dispatch directly.)
	if (tauri) {
		void tauri.globalShortcuts.startListening().then((unlisten) => {
			if (destroyed) unlisten();
			else cleanupTapListener = unlisten;
		});
	}

	return () => {
		destroyed = true;
		cleanupTapListener?.();
		void tauri?.globalShortcuts.unregisterChords();
	};
}
