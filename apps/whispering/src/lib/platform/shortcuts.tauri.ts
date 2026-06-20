import { extractErrorMessage } from 'wellcrafted/error';
import { Err, tryAsync } from 'wellcrafted/result';
import { os } from '#platform/os';
import { type Command, commands } from '$lib/commands';
import {
	DEFAULT_GLOBAL_BINDINGS,
	deviceConfig,
} from '$lib/state/device-config.svelte';
import type { CommandBinding, KeyBinding } from '$lib/tauri/commands';
import { type ChordRegistration, tauriOnly } from '$lib/tauri.tauri';
import {
	bindingsOverlap,
	isEmptyBinding,
	keyBindingToLabel,
	resolveBinding,
} from '$lib/utils/key-binding';
import { validateGlobalBinding } from '$lib/utils/reserved-shortcuts';
import { createShortcuts } from './shortcuts.shared';
import type { Shortcuts } from './types';

/**
 * Desktop build of `#platform/shortcuts`: system-global gestures driven by the
 * rdev backend, stored in device-config under `shortcuts.global.*` (never
 * synced across devices). The default bindings live in `DEFAULT_GLOBAL_BINDINGS`
 * because they double as the device-config schema defaults.
 */

const globalKey = (id: Command['id']) => `shortcuts.global.${id}` as const;

/**
 * The stored shape's `keys` are plain `string[]` (validated structurally in
 * device-config and by name in Rust), so the read crosses into the IPC
 * `KeyBinding` (`keys: Key[]`) with one documented cast at this boundary.
 */
function readBinding(id: Command['id']): KeyBinding | null {
	return (deviceConfig.get(globalKey(id)) as KeyBinding | null) ?? null;
}

export const shortcuts: Shortcuts = createShortcuts({
	read: readBinding,
	getDefault: (id) => DEFAULT_GLOBAL_BINDINGS[id] ?? null,
	write: (id, binding) => deviceConfig.set(globalKey(id), binding),
	// The rdev matcher fires on exact set equality with no prefix resolution, so a
	// gesture that contains (or is contained by) another would shadow it or be
	// unreachable. Refuse reserved gestures and overlaps, naming the collision.
	findConflict: (id, binding) => {
		const reserved = validateGlobalBinding(binding);
		if (reserved) return reserved;
		for (const command of commands) {
			if (command.id === id) continue;
			const other = readBinding(command.id);
			if (other && !isEmptyBinding(other) && bindingsOverlap(other, binding)) {
				return `Those keys are already part of the "${command.title}" gesture (${keyBindingToLabel(other, os.isApple)}). Each global gesture needs its own keys, so a key used by one gesture cannot be part of another.`;
			}
		}
		return null;
	},
	syncErrorTitle: 'Error registering global shortcuts',
	async push(entries) {
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
				await tauriOnly.keyboard.registerChords(chords);
				await tauriOnly.keyboard.setBindings(taps);
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
