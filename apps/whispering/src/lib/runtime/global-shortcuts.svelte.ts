import { toast } from '@epicenter/ui/sonner';
import { extractErrorMessage } from 'wellcrafted/error';
import { Err, tryAsync } from 'wellcrafted/result';
import { os } from '#platform/os';
import { tauri } from '#platform/tauri';
import { type Command, commands } from '$lib/commands';
import { report } from '$lib/report';
import { deviceConfig } from '$lib/state/device-config.svelte';
import type { CommandBinding, KeyBinding } from '$lib/tauri/commands';
import { environment } from './environment.svelte';

type GlobalShortcutKey = `shortcuts.global.${Command['id']}`;

function globalShortcutKey(commandId: Command['id']): GlobalShortcutKey {
	return `shortcuts.global.${commandId}`;
}

export function installGlobalShortcutRuntime() {
	$effect(() => {
		if (!tauri) return;
		let unlisten: (() => void) | undefined;
		let disposed = false;
		void tauri.globalShortcuts
			.listenForStopped(() => {
				environment.setListenerAlive(false);
			})
			.then((dispose) => {
				if (disposed) {
					dispose();
					return;
				}
				unlisten = dispose;
			});
		return () => {
			disposed = true;
			unlisten?.();
		};
	});

	$effect(() => {
		if (!tauri) return;
		if (os.isApple && !environment.accessibilityGranted) return;

		const listenerAlive = environment.listenerAlive;
		// Project device config into the replace-all set the native listener
		// wants: every command with a configured binding, in registry order.
		const bindings: CommandBinding[] = [];
		for (const command of commands) {
			const binding = deviceConfig.get(
				globalShortcutKey(command.id),
			) as KeyBinding | null;
			if (binding) bindings.push({ commandId: command.id, binding });
		}

		void reconcileGlobalShortcuts({ bindings, listenerAlive });
	});
}

async function reconcileGlobalShortcuts({
	bindings,
	listenerAlive,
}: {
	bindings: CommandBinding[];
	listenerAlive: boolean;
}) {
	if (!tauri) return;
	const t = tauri;

	const { error } = await tryAsync({
		try: () => t.globalShortcuts.setBindings(bindings),
		catch: (cause) =>
			Err({
				name: 'GlobalShortcutRegistrationFailed',
				message: extractErrorMessage(cause),
			}),
	});
	if (error) {
		report.error({ title: 'Error registering global shortcuts', cause: error });
		return;
	}

	if (listenerAlive) return;

	const status = await t.globalShortcuts.start();
	if (status === 'started' || status === 'alreadyRunning') {
		environment.setListenerAlive(true);
		return;
	}

	// Wayland never starts the listener, so the reconciler re-reaches this path
	// on every binding edit. A stable id keeps the warning a single standing
	// toast instead of stacking one per edit.
	toast.warning('Global shortcuts unavailable on Wayland', {
		id: 'global-shortcuts-wayland-unsupported',
		description:
			'Whispering needs an X11 session for global shortcuts. On Wayland, bind them through your desktop environment.',
		duration: Number.POSITIVE_INFINITY,
	});
}
