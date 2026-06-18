import { tauri } from '#platform/tauri';

/**
 * Subscribe to the Tier-1 tap's trigger channel so its Fn/modifier-only holds
 * dispatch into the command layer. Rust owns the tap lifecycle (start it, gate
 * it on live Accessibility trust, restart it on death); this owner only listens
 * for the triggers it emits. Desktop only. The Tier-0 plugin chords do not flow
 * through here (their handlers dispatch directly), and the browser equivalent is
 * `attachLocalShortcutListener`.
 */
export function attachGlobalShortcutTriggers() {
	let cleanup: (() => void) | undefined;
	let destroyed = false;

	if (tauri) {
		void tauri.keyboard.startTriggerDispatch().then((unlisten) => {
			if (destroyed) unlisten();
			else cleanup = unlisten;
		});
	}

	return () => {
		destroyed = true;
		cleanup?.();
	};
}
