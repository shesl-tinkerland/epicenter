import { partitionResults } from 'wellcrafted/result';
import { goto } from '$app/navigation';
import { type Command, commandCallbacks, commands } from '$lib/commands';
import type { KeyboardEventSupportedKey } from '$lib/constants/keyboard';
import { report } from '$lib/report';
import { services } from '$lib/services';
import {
	type CommandId,
	shortcutStringToArray,
} from '$lib/services/local-shortcut-manager';
import {
	DEFAULT_GLOBAL_BINDINGS,
	deviceConfig,
} from '$lib/state/device-config.svelte';
import { settings } from '$lib/state/settings.svelte';

/**
 * Local shortcuts - cross-platform, work in web and desktop.
 * These use browser keyboard events.
 */
export const localShortcuts = {
	registerCommand: ({
		command,
		keyCombination,
	}: {
		command: Command;
		keyCombination: KeyboardEventSupportedKey[];
	}) =>
		services.localShortcutManager.register({
			id: command.id as CommandId,
			keyCombination,
			callback: commandCallbacks[command.id],
			on: command.on,
		}),

	unregisterCommand: async ({ commandId }: { commandId: CommandId }) =>
		services.localShortcutManager.unregister(commandId),
};

/**
 * Default values for in-app (local) shortcuts, keyed by command id string. A
 * superset of the current build's commands: `openTransformationPicker` is
 * desktop-only, so on web it sits here unused (the reset loops iterate the
 * platform `commands`). Mirrors `DEFAULT_GLOBAL_BINDINGS`, which is keyed the
 * same way.
 */
const DEFAULT_LOCAL_SHORTCUTS = {
	pushToTalk: 'p',
	toggleManualRecording: ' ',
	cancelRecording: 'c',
	toggleVadRecording: 'v',
	openTransformationPicker: 't',
	runTransformationOnClipboard: 'r',
} as const satisfies Record<string, string | null>;

/** Canonical string for a binding, so structurally-equal bindings dedupe. */
function bindingKey(binding: {
	modifiers: readonly string[];
	keys: readonly string[];
}): string {
	return JSON.stringify({
		modifiers: [...binding.modifiers].sort(),
		keys: [...binding.keys].sort(),
	});
}

type LocalShortcutKey = `shortcut.${Command['id']}`;
type GlobalShortcutKey = `shortcuts.global.${Command['id']}`;

function getLocalShortcutKey(commandId: Command['id']): LocalShortcutKey {
	return `shortcut.${commandId}`;
}

function getGlobalShortcutKey(commandId: Command['id']): GlobalShortcutKey {
	return `shortcuts.global.${commandId}`;
}

/**
 * Synchronizes local keyboard shortcuts with the current settings.
 * - Registers shortcuts that have key combinations defined in settings
 * - Unregisters shortcuts that don't have key combinations defined
 * - Shows error toast if any registration/unregistration fails
 */
export async function syncLocalShortcutsWithSettings() {
	const results = await Promise.all(
		commands
			.map((command) => {
				const keyCombination = settings.get(getLocalShortcutKey(command.id));
				if (!keyCombination) {
					return localShortcuts.unregisterCommand({
						commandId: command.id as CommandId,
					});
				}
				return localShortcuts.registerCommand({
					command,
					keyCombination: shortcutStringToArray(String(keyCombination)),
				});
			})
			.filter((result) => result !== undefined),
	);
	const { errs } = partitionResults(results);
	if (errs.length > 0) {
		report.error({
			title: 'Error registering local commands',
			cause: {
				name: 'LocalShortcutRegistrationFailed',
				message: errs.map((err) => err.error.message).join('\n'),
			},
		});
	}
}

// Global shortcuts are no longer pushed to the rdev backend from here. The
// global-shortcut runtime (`$lib/runtime/global-shortcuts.svelte`) reconciles
// the native binding set from device config, so writing the config is the only
// step a caller takes; the reconciler does the rest.

/**
 * Checks if any local shortcuts are duplicated and resets all to defaults if duplicates found.
 * Returns true if duplicates were found and reset, false otherwise.
 */
export function resetLocalShortcutsToDefaultIfDuplicates(): boolean {
	const seen = new Map<string, string>();

	// Check for duplicates
	for (const command of commands) {
		const shortcut = settings.get(getLocalShortcutKey(command.id));
		if (shortcut) {
			if (seen.has(String(shortcut))) {
				// If duplicates found, reset all local shortcuts to defaults
				resetLocalShortcuts();
				report.success({
					title: 'Shortcuts reset',
					description:
						'Duplicate local shortcuts detected. All local shortcuts have been reset to defaults.',
					action: {
						label: 'Configure shortcuts',
						onClick: () => goto('/settings/shortcuts'),
					},
				});

				return true;
			}
			seen.set(String(shortcut), command.id);
		}
	}
	return false;
}

/**
 * Checks if any global shortcuts are duplicated and resets all to defaults if duplicates found.
 * Returns true if duplicates were found and reset, false otherwise.
 */
export function resetGlobalShortcutsToDefaultIfDuplicates(): boolean {
	const seen = new Map<string, string>();

	// Check for duplicates by canonical binding string.
	for (const command of commands) {
		const binding = deviceConfig.get(getGlobalShortcutKey(command.id));
		if (!binding) continue;
		const key = bindingKey(binding);
		if (seen.has(key)) {
			// If duplicates found, reset all global shortcuts to defaults
			resetGlobalShortcuts();
			report.success({
				title: 'Shortcuts reset',
				description:
					'Duplicate global shortcuts detected. All global shortcuts have been reset to defaults.',
				action: {
					label: 'Configure shortcuts',
					onClick: () => goto('/settings/shortcuts'),
				},
			});

			return true;
		}
		seen.set(key, command.id);
	}
	return false;
}

/**
 * Reset all local shortcuts to their default values and re-sync.
 */
export function resetLocalShortcuts() {
	for (const command of commands) {
		settings.set(
			getLocalShortcutKey(command.id),
			DEFAULT_LOCAL_SHORTCUTS[command.id] ?? null,
		);
	}
	void syncLocalShortcutsWithSettings();
}

/**
 * Reset all global shortcuts to their default values. The global-shortcut
 * runtime reconciles the native binding set from these device-config writes,
 * so there is no manual re-sync to call.
 */
export function resetGlobalShortcuts() {
	for (const command of commands) {
		deviceConfig.set(
			getGlobalShortcutKey(command.id),
			DEFAULT_GLOBAL_BINDINGS[command.id] ?? null,
		);
	}
}
