import type { UnlistenFn } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { tauri } from '#platform/tauri';
import { goto } from '$app/navigation';
import { revealMainWindow } from '$lib/main-window';

/**
 * Bring the main window to the front when an auxiliary window asks for it (the
 * recording overlay pill, the transformation picker's "Manage transformations").
 * Reveals first (show + unminimize + focus) so a minimized main window actually
 * surfaces, then routes if the request carried a path. Desktop only.
 */
export function attachMainWindowReveal() {
	if (!tauri) return () => {};

	let unlisten: UnlistenFn | undefined;
	let destroyed = false;

	void revealMainWindow
		.listen(async ({ payload }) => {
			const mainWindow = getCurrentWindow();
			await mainWindow.show();
			await mainWindow.unminimize();
			// setFocus often fails on macOS; ignore.
			await mainWindow.setFocus().catch(() => {});
			if (payload.path) await goto(payload.path);
		})
		.then((fn) => {
			if (destroyed) fn();
			else unlisten = fn;
		});

	return () => {
		destroyed = true;
		unlisten?.();
	};
}
