import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { tauri } from '#platform/tauri';
import { goto } from '$app/navigation';
import { dictationCapability } from '$lib/state/dictation-capability.svelte';
import { localModel } from '$lib/state/local-model.svelte';
import { settings } from '$lib/state/settings.svelte';
import { checkForUpdates } from './check-for-updates';

export function attachDesktopEvents() {
	let unlistenNavigate: UnlistenFn | undefined;
	let unlistenLocalModel: UnlistenFn | undefined;
	let cleanupCapability: (() => void) | undefined;

	if (tauri) {
		const t = tauri;
		// Auto-paste writes at the cursor via a synthetic Cmd/Ctrl+V, which needs
		// the same macOS Accessibility grant the tap does. Keep the tap supervisor
		// told whether either paste mode is on, so it holds the tap to track that
		// grant (and surfaces the notice if missing) even with no Fn binding.
		$effect(() => {
			const autoPaste =
				settings.get('output.transcription.cursor') ||
				settings.get('output.recipe.cursor');
			void t.globalShortcuts.setAutoPasteEnabled(autoPaste);
		});

		void checkForUpdates();
		void (async () => {
			unlistenNavigate = await listen<{ path: string }>(
				'navigate-main-window',
				(event) => {
					goto(event.payload.path);
				},
			);
			unlistenLocalModel = await localModel.attach();
			cleanupCapability = dictationCapability.attach();
		})();
	}

	return () => {
		unlistenNavigate?.();
		unlistenLocalModel?.();
		cleanupCapability?.();
	};
}
