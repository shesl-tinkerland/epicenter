import { type UnlistenFn } from '@tauri-apps/api/event';
import { localModel } from '$lib/state/local-model.svelte';

/**
 * Keep the reactive `localModel` mirror in sync with the Rust `ModelManager`.
 * `localModel.attach()` is async and self-no-ops off the desktop build, so this
 * owner just bridges its promise into the sync attach/detach contract.
 */
export function attachLocalModelState() {
	let unlisten: UnlistenFn | undefined;
	let destroyed = false;

	void localModel.attach().then((fn) => {
		if (destroyed) fn();
		else unlisten = fn;
	});

	return () => {
		destroyed = true;
		unlisten?.();
	};
}
