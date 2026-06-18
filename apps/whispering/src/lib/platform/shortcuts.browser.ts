import { type Command, commands } from '$lib/commands';
import {
	type CommandId,
	localShortcuts,
} from '$lib/services/local-shortcut-manager';
import { settings } from '$lib/state/settings.svelte';
import {
	bindingsEqual,
	keyBindingToString,
	parseManualBinding,
} from '$lib/utils/key-binding';
import { createShortcuts } from './shortcuts.shared';
import type { Shortcuts } from './types';

/**
 * Web build of `#platform/shortcuts`: in-app (focused-window) shortcuts driven
 * by the browser keydown manager, stored in workspace KV under `shortcut.*` as
 * the readable manual grammar (`"ctrl+shift+a"`). The KV cell is `field.string()`
 * either way; this just speaks the same physical `KeyBinding` the matcher and the
 * desktop tier use, parsed on read and serialized on write.
 */

const localKey = (id: Command['id']) => `shortcut.${id}` as const;

/** A stored shortcut string, parsed to a `KeyBinding` (`null` when unset or stale). */
const readBinding = (id: Command['id']) => {
	const stored = settings.get(localKey(id));
	return stored ? parseManualBinding(stored) : null;
};

export const shortcuts: Shortcuts = createShortcuts({
	read: readBinding,
	getDefault: (id) => {
		const stored = settings.getDefault(localKey(id));
		return stored ? parseManualBinding(stored) : null;
	},
	write: (id, binding) =>
		settings.set(localKey(id), binding ? keyBindingToString(binding) : null),
	// The keydown matcher fires every command whose set matches, so two commands
	// sharing a set would both trigger. Refuse an exact duplicate at write time.
	findConflict: (id, binding) => {
		for (const command of commands) {
			if (command.id === id) continue;
			const other = readBinding(command.id);
			if (other && bindingsEqual(other, binding)) {
				return `Those keys already trigger "${command.title}". Pick a different combination.`;
			}
		}
		return null;
	},
	syncErrorTitle: 'Error registering local commands',
	// Registration is an in-memory Map write, so it cannot fail: push always
	// succeeds. The contract stays async because the desktop tier's push does IPC.
	async push(entries) {
		for (const { command, binding } of entries) {
			if (binding) localShortcuts.registerCommand({ command, binding });
			else
				localShortcuts.unregisterCommand({
					commandId: command.id as CommandId,
				});
		}
		return null;
	},
});
