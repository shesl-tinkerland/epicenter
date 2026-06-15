<script lang="ts">
	import * as Alert from '@epicenter/ui/alert';
	import AlertTriangle from '@lucide/svelte/icons/alert-triangle';
	import type { Command } from '$lib/commands';
	import type { KeyboardEventSupportedKey } from '$lib/constants/keyboard';
	import { report } from '$lib/report';
	import { localShortcuts } from '$lib/operations/shortcuts';
	import {
		arrayToShortcutString,
		type CommandId,
	} from '$lib/services/local-shortcut-manager';
	import { settings } from '$lib/state/settings.svelte';
	import { os } from '#platform/os';
	import { getShortcutDisplayLabel } from '$lib/utils/keyboard';
	import { type PressedKeys } from '$lib/utils/createPressedKeys.svelte';
	import { createKeyRecorder } from './create-key-recorder.svelte';
	import RecorderShell from './RecorderShell.svelte';

	const {
		command,
		placeholder,
		pressedKeys,
	}: {
		command: Command;
		placeholder?: string;
		pressedKeys: PressedKeys;
	} = $props();

	const shortcutValue = $derived(settings.get(`shortcut.${command.id}`));
	const label = $derived(
		shortcutValue ? getShortcutDisplayLabel(shortcutValue) : null,
	);

	// svelte-ignore state_referenced_locally -- pressedKeys is the stable recorder handle for this mounted shortcut table.
	const keyRecorder = createKeyRecorder({
		pressedKeys,
		onRegister: async (keyCombination: KeyboardEventSupportedKey[]) => {
			const { error: unregisterError } = await localShortcuts.unregisterCommand({
				commandId: command.id as CommandId,
			});
			if (unregisterError) {
				report.error({
					title: 'Error unregistering local shortcut',
					cause: unregisterError,
				});
			}
			const { error: registerError } = await localShortcuts.registerCommand({
				command,
				keyCombination,
			});

			if (registerError) {
				report.error({
					title: 'Error registering local shortcut',
					cause: registerError,
				});
				return;
			}

			settings.set(
				`shortcut.${command.id}`,
				arrayToShortcutString(keyCombination),
			);

			report.success({
				title: `Local shortcut set to ${keyCombination}`,
				description: `Press the shortcut to trigger "${command.title}"`,
			});
		},
		onClear: async () => {
			const { error: unregisterError } = await localShortcuts.unregisterCommand({
				commandId: command.id as CommandId,
			});
			if (unregisterError) {
				report.error({
					title: 'Error clearing local shortcut',
					cause: unregisterError,
				});
			}
			settings.set(`shortcut.${command.id}`, null);

			report.success({
				title: 'Local shortcut cleared',
				description: `Please set a new shortcut to trigger "${command.title}"`,
			});
		},
	});

	const recorder = {
		get isListening() {
			return keyRecorder.isListening;
		},
		get label() {
			return label;
		},
		get manualInitial() {
			return shortcutValue ?? '';
		},
		start: () => keyRecorder.start(),
		stop: () => keyRecorder.stop(),
		clear: () => keyRecorder.clear(),
		submitManual: (raw: string) =>
			keyRecorder.register(raw.split('+') as KeyboardEventSupportedKey[]),
	};
</script>

<RecorderShell
	title={command.title}
	{recorder}
	copy={{
		placeholder,
		recordHelp: 'Click to record or edit manually',
		manualHelp: 'Enter shortcut manually (e.g., ctrl+shift+a)',
		manualPlaceholder: 'e.g., ctrl+shift+a',
		manualButtonLabel: 'Edit manually',
	}}
>
	{#snippet warning()}
		{#if os.isApple}
			<Alert.Root variant="warning" class="text-xs">
				<AlertTriangle class="size-4" />
				<Alert.Title class="text-xs font-medium">Apple Keyboard Note</Alert.Title>
				<Alert.Description class="text-xs">
					Some Option+key combinations (E, I, N, U, `) may not record properly.
					Try recording in reverse (press letter first, then Option) or edit
					manually.
				</Alert.Description>
			</Alert.Root>
		{/if}
	{/snippet}
</RecorderShell>
