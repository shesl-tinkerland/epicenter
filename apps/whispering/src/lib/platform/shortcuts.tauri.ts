import { extractErrorMessage } from 'wellcrafted/error';
import { Err, tryAsync } from 'wellcrafted/result';
import { os } from '#platform/os';
import type { Command } from '$lib/commands';
import {
	DEFAULT_GLOBAL_BINDINGS,
	deviceConfig,
} from '$lib/state/device-config.svelte';
import type { CommandBinding, KeyBinding } from '$lib/tauri/commands';
import { type ChordRegistration, tauriOnly } from '$lib/tauri.tauri';
import { keyBindingToLabel, resolveBinding } from '$lib/utils/key-binding';
import { createShortcuts } from './shortcuts.shared';
import type { Shortcuts } from './types';

/**
 * Desktop build of `#platform/shortcuts`: system-global gestures driven by the
 * rdev backend, stored in device-config under `shortcuts.global.*` (never
 * synced across devices). The default bindings live in `DEFAULT_GLOBAL_BINDINGS`
 * because they double as the device-config schema defaults.
 */

const globalKey = (id: Command['id']) => `shortcuts.global.${id}` as const;

function readBinding(id: Command['id']) {
	return deviceConfig.get(globalKey(id));
}

/** The stored global-binding shape (`keys` are plain strings, validated by Rust). */
type GlobalBinding = NonNullable<ReturnType<typeof readBinding>>;

export const shortcuts: Shortcuts = createShortcuts<GlobalBinding>({
	read: readBinding,
	getDefault: (id) => DEFAULT_GLOBAL_BINDINGS[id] ?? null,
	write: (id, binding) => deviceConfig.set(globalKey(id), binding),
	label: (binding) => (binding ? keyBindingToLabel(binding, os.isApple) : ''),
	syncErrorTitle: 'Error registering global shortcuts',
	async push(entries) {
		// The cast bridges the stored `string[]` to the IPC `Key[]`; the keys are
		// validated structurally on store and by Rust at the IPC boundary.
		const bindings: CommandBinding[] = entries
			.filter((entry) => entry.binding !== null)
			.map((entry) => ({
				commandId: entry.command.id,
				binding: entry.binding as KeyBinding,
			}));
		// Partition by what each binding needs. A chord maps to an accelerator and
		// goes to the permission-free plugin (Tier 0); an Fn or modifier-only hold
		// maps to none and goes to the tap (Tier 1), which spins up only for these.
		// Each binding lands in exactly one backend, so the two never double-fire.
		const chords: ChordRegistration[] = [];
		const taps: CommandBinding[] = [];
		for (const entry of bindings) {
			const resolved = resolveBinding(entry.binding);
			if (resolved.tier === 'chord') {
				chords.push({
					commandId: entry.commandId,
					accelerator: resolved.accelerator,
				});
			} else {
				taps.push(entry);
			}
		}
		// A plugin register the OS rejects (a chord another app holds) or a bad tap
		// key fails the whole replace-all; surface it instead of partially binding.
		const { error } = await tryAsync({
			try: async () => {
				await tauriOnly.globalShortcuts.registerChords(chords);
				await tauriOnly.globalShortcuts.setBindings(taps);
			},
			catch: (cause) =>
				Err({
					name: 'GlobalShortcutRegistrationFailed',
					message: extractErrorMessage(cause),
				}),
		});
		return error ?? null;
	},
});
