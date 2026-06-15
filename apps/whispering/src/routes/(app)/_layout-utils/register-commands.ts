import { extractErrorMessage } from 'wellcrafted/error';
import { Err, partitionResults, tryAsync } from 'wellcrafted/result';
import { tauri } from '#platform/tauri';
import { goto } from '$app/navigation';
import { type Command, commands } from '$lib/commands';
import { localShortcuts } from '$lib/operations/shortcuts';
import { report } from '$lib/report';
import {
	type CommandId,
	shortcutStringToArray,
} from '$lib/services/local-shortcut-manager';
import {
	DEFAULT_GLOBAL_BINDINGS,
	deviceConfig,
} from '$lib/state/device-config.svelte';
import { settings } from '$lib/state/settings.svelte';
import type { CommandBinding, KeyBinding } from '$lib/tauri/commands';

/** Default values for in-app (local) shortcuts. Keyed by command id string. */
const DEFAULT_LOCAL_SHORTCUTS = {
	pushToTalk: 'p',
	toggleManualRecording: ' ',
	cancelRecording: 'c',
	toggleVadRecording: 'v',
	openTransformationPicker: 't',
	runTransformationOnClipboard: 'r',
} as const satisfies Record<Command['id'], string | null>;

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

/**
 * Pushes the configured global shortcuts to the desktop rdev backend as the
 * full replace-all set. Storage holds structured `KeyBinding`s (physical-key
 * space), so they go straight through with no parsing.
 */
export async function syncGlobalShortcutsWithSettings() {
	if (!tauri) return;
	const { globalShortcuts } = tauri;

	const bindings: CommandBinding[] = [];
	for (const command of commands) {
		const binding = deviceConfig.get(getGlobalShortcutKey(command.id));
		if (!binding) continue;
		// Storage validates keys as plain strings; Rust validates them by name on
		// register. The cast bridges the stored `string[]` to the IPC `Key[]`.
		bindings.push({ commandId: command.id, binding: binding as KeyBinding });
	}

	// Keys are stored as plain strings and validated by Rust at the IPC boundary,
	// so a single bad key fails the whole replace-all call. Surface it instead of
	// letting every global shortcut silently go unregistered.
	const { error } = await tryAsync({
		try: () => globalShortcuts.setBindings(bindings),
		catch: (cause) =>
			Err({
				name: 'GlobalShortcutRegistrationFailed',
				message: extractErrorMessage(cause),
			}),
	});
	if (error) {
		report.error({ title: 'Error registering global shortcuts', cause: error });
	}
}

/**
 * Checks if any local shortcuts are duplicated and resets all to defaults if duplicates found.
 * Returns true if duplicates were found and reset, false otherwise.
 */
export function resetLocalShortcutsToDefaultIfDuplicates(): boolean {
	const localShortcuts = new Map<string, string>();

	// Check for duplicates
	for (const command of commands) {
		const shortcut = settings.get(getLocalShortcutKey(command.id));
		if (shortcut) {
			if (localShortcuts.has(String(shortcut))) {
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
			localShortcuts.set(String(shortcut), command.id);
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
 * Reset all global shortcuts to their default values and re-sync.
 */
export function resetGlobalShortcuts() {
	for (const command of commands) {
		deviceConfig.set(
			getGlobalShortcutKey(command.id),
			DEFAULT_GLOBAL_BINDINGS[command.id] ?? null,
		);
	}
	void syncGlobalShortcutsWithSettings();
}
