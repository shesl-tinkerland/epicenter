import { tauri } from '#platform/tauri';
import { report } from '$lib/report';
import { deviceConfig } from '$lib/state/device-config.svelte';
import { commands } from '$lib/tauri/commands';

export function installUnloadPolicyRuntime() {
	$effect(() => {
		if (!tauri) return;

		void commands
			.setUnloadPolicy(deviceConfig.get('transcription.localModelUnloadPolicy'))
			.catch((cause) => {
				report.error({
					title: 'Failed to update local model unload policy',
					cause,
				});
			});
	});
}
