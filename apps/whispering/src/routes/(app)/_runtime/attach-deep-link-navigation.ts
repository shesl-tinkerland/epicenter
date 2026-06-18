import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { tauri } from '#platform/tauri';
import { goto } from '$app/navigation';

/**
 * Route the window to a path the OS hands us via the `navigate-main-window`
 * event (deep links, tray actions). Desktop only.
 */
export function attachDeepLinkNavigation() {
	let unlisten: UnlistenFn | undefined;
	let destroyed = false;

	if (tauri) {
		void listen<{ path: string }>('navigate-main-window', (event) => {
			goto(event.payload.path);
		}).then((fn) => {
			if (destroyed) fn();
			else unlisten = fn;
		});
	}

	return () => {
		destroyed = true;
		unlisten?.();
	};
}
