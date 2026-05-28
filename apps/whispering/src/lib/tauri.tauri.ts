/**
 * Tauri-only capability namespace. Everything that requires the Tauri
 * runtime lives in this file: fs, permissions, window, tray,
 * globalShortcuts, autostart. The subset that needs TanStack caching,
 * error transformation, or invalidation is exposed in the same shape
 * (no sub-namespace), with each leaf picking one canonical call form.
 *
 * Two files, one import path:
 *
 *     this file                                 -> Tauri build
 *     `./tauri.browser.ts` (exports `null`)     -> web build
 *
 * Vite picks one at build time via `resolve.extensions` in
 * `vite.config.ts`. TypeScript picks this one for type-checking on both
 * builds via `moduleSuffixes` in `tsconfig.json`, so consumers always
 * see the full `Tauri | null` shape.
 *
 * Two patterns, one for each use case:
 *
 *     import { tauri } from '$lib/tauri';
 *     if (tauri) await tauri.fs.pathsToFiles(paths);
 *     // or
 *     await tauri?.fs.pathsToFiles(paths);
 *
 *     // Inside *.tauri.ts files only (build guarantees Tauri runtime):
 *     import { tauriOnly } from '$lib/tauri';
 *     await tauriOnly.fs.pathsToFiles(paths);
 *
 * `tauri` doubles as the platform check: truthy means we're on Tauri
 * and the whole namespace is available. There is no separate
 * `__TAURI_INTERNALS__` check; the value IS the check.
 *
 * Why the `: Tauri | null` annotation on a never-null local: it widens the
 * export type so consumers are forced to narrow.
 *
 * See `specs/20260526T000140-collapse-tauri-only-services-into-namespace.md`.
 */

import { Menu, MenuItem } from '@tauri-apps/api/menu';
import { basename, resolveResource } from '@tauri-apps/api/path';
import { TrayIcon } from '@tauri-apps/api/tray';
import { getCurrentWindow } from '@tauri-apps/api/window';
import {
	disable as disableAutostart,
	enable as enableAutostart,
	isEnabled as isAutostartEnabled,
} from '@tauri-apps/plugin-autostart';
import { readFile } from '@tauri-apps/plugin-fs';
import {
	isRegistered as tauriIsRegistered,
	register as tauriRegister,
	unregister as tauriUnregister,
	unregisterAll as tauriUnregisterAll,
} from '@tauri-apps/plugin-global-shortcut';
import { exit } from '@tauri-apps/plugin-process';
import mime from 'mime';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { Err, Ok, type Result, tryAsync } from 'wellcrafted/result';
import { goto } from '$app/navigation';
import type { Command, ShortcutEventState } from '$lib/commands';
import type { WhisperingRecordingState } from '$lib/constants/audio';
import { IS_MACOS } from '$lib/constants/platform';
import { defineMutation, defineQuery, queryClient } from '$lib/rpc/client';
import { autostartKeys } from '$lib/tauri/autostart-keys';
import { commands } from '$lib/tauri/commands';
import {
	type Accelerator,
	AcceleratorError,
	type InvalidAcceleratorError,
	isValidElectronAccelerator,
} from '$lib/utils/accelerator';

// fs ----------------------------------------------------------------
const FsError = defineErrors({
	ReadFilesFailed: ({ paths, cause }: { paths: string[]; cause: unknown }) => ({
		message: `Failed to read files: ${paths.join(', ')}: ${extractErrorMessage(cause)}`,
		paths,
		cause,
	}),
});

async function readFileWithMimeType(path: string): Promise<{
	bytes: Uint8Array<ArrayBuffer>;
	mimeType: string;
}> {
	// Cast is safe: Tauri's readFile always returns ArrayBuffer-backed Uint8Array.
	const bytes = (await readFile(path)) as Uint8Array<ArrayBuffer>;
	const mimeType = mime.getType(path) ?? 'application/octet-stream';
	return { bytes, mimeType };
}

const fs = {
	pathsToFiles: (paths: string[]) =>
		tryAsync({
			try: () =>
				Promise.all(
					paths.map(async (path) => {
						const { bytes, mimeType } = await readFileWithMimeType(path);
						const fileName = await basename(path);
						return new File([bytes], fileName, { type: mimeType });
					}),
				),
			catch: (error) => FsError.ReadFilesFailed({ paths, cause: error }),
		}),
};

// permissions -------------------------------------------------------
const PermissionsError = defineErrors({
	CheckAccessibility: ({ cause }: { cause: unknown }) => ({
		message: `Failed to check accessibility permissions: ${extractErrorMessage(cause)}`,
		cause,
	}),
	RequestAccessibility: ({ cause }: { cause: unknown }) => ({
		message: `Failed to request accessibility permissions: ${extractErrorMessage(cause)}`,
		cause,
	}),
	OpenAccessibilitySettings: ({ cause }: { cause: unknown }) => ({
		message: `Failed to open accessibility settings: ${extractErrorMessage(cause)}`,
		cause,
	}),
	CheckMicrophone: ({ cause }: { cause: unknown }) => ({
		message: `Failed to check microphone permissions: ${extractErrorMessage(cause)}`,
		cause,
	}),
	RequestMicrophone: ({ cause }: { cause: unknown }) => ({
		message: `Failed to request microphone permissions: ${extractErrorMessage(cause)}`,
		cause,
	}),
});

const permissions = {
	accessibility: {
		async check() {
			if (!IS_MACOS) return Ok(true);
			return tryAsync({
				try: async () => {
					const { checkAccessibilityPermission } = await import(
						'tauri-plugin-macos-permissions-api'
					);
					return checkAccessibilityPermission();
				},
				catch: (error) => PermissionsError.CheckAccessibility({ cause: error }),
			});
		},

		async request() {
			if (!IS_MACOS) return Ok(true);
			return tryAsync({
				try: async () => {
					const { requestAccessibilityPermission } = await import(
						'tauri-plugin-macos-permissions-api'
					);
					return requestAccessibilityPermission();
				},
				catch: (error) =>
					PermissionsError.RequestAccessibility({ cause: error }),
			});
		},

		async openSettings() {
			if (!IS_MACOS) return Ok(undefined);
			const { error } = await commands.openAccessibilitySettings();
			if (error !== null) {
				return PermissionsError.OpenAccessibilitySettings({ cause: error });
			}
			return Ok(undefined);
		},
	},

	microphone: {
		async check() {
			if (!IS_MACOS) return Ok(true);
			return tryAsync({
				try: async () => {
					const { checkMicrophonePermission } = await import(
						'tauri-plugin-macos-permissions-api'
					);
					return checkMicrophonePermission();
				},
				catch: (error) => PermissionsError.CheckMicrophone({ cause: error }),
			});
		},

		async request() {
			if (!IS_MACOS) return Ok(true);
			return tryAsync({
				try: async () => {
					const { requestMicrophonePermission } = await import(
						'tauri-plugin-macos-permissions-api'
					);
					return requestMicrophonePermission();
				},
				catch: (error) => PermissionsError.RequestMicrophone({ cause: error }),
			});
		},
	},
};

// window ------------------------------------------------------------
const window = {
	setAlwaysOnTop: (value: boolean) => getCurrentWindow().setAlwaysOnTop(value),
};

// tray --------------------------------------------------------------
const TrayError = defineErrors({
	SetIcon: ({ cause }: { cause: unknown }) => ({
		message: `Failed to set tray icon: ${extractErrorMessage(cause)}`,
		cause,
	}),
});

const TRAY_ID = 'whispering-tray';
let trayPromise: ReturnType<typeof initTray> | null = null;

async function getIconPath(recorderState: WhisperingRecordingState) {
	const iconPaths = {
		IDLE: 'recorder-state-icons/studio_microphone.png',
		RECORDING: 'recorder-state-icons/red_large_square.png',
	} as const satisfies Record<WhisperingRecordingState, string>;
	return resolveResource(iconPaths[recorderState]);
}

async function initTray() {
	const existing = await TrayIcon.getById(TRAY_ID);
	if (existing) return existing;

	const trayMenu = await Menu.new({
		items: [
			await MenuItem.new({
				id: 'show',
				text: 'Show Window',
				action: () => getCurrentWindow().show(),
			}),
			await MenuItem.new({
				id: 'hide',
				text: 'Hide Window',
				action: () => getCurrentWindow().hide(),
			}),
			await MenuItem.new({
				id: 'settings',
				text: 'Settings',
				action: () => {
					goto('/settings');
					return getCurrentWindow().show();
				},
			}),
			await MenuItem.new({
				id: 'quit',
				text: 'Quit',
				action: () => void exit(0),
			}),
		],
	});

	return TrayIcon.new({
		id: TRAY_ID,
		icon: await getIconPath('IDLE'),
		menu: trayMenu,
		menuOnLeftClick: false,
		action: (e) => {
			if (
				e.type === 'Click' &&
				e.button === 'Left' &&
				e.buttonState === 'Down'
			) {
				return true;
			}
			return false;
		},
	});
}

// globalShortcuts ---------------------------------------------------
// Pure accelerator parsing/validation lives in `$lib/utils/accelerator`
// since it has no Tauri runtime dependency. Only the registration ops
// (which talk to Tauri's global-shortcut plugin) live here.
const ShortcutError = defineErrors({
	RegisterFailed: ({
		accelerator,
		cause,
	}: {
		accelerator: string;
		cause: unknown;
	}) => ({
		message: `Failed to register global shortcut '${accelerator}': ${extractErrorMessage(cause)}`,
		accelerator,
		cause,
	}),
	UnregisterFailed: ({
		accelerator,
		cause,
	}: {
		accelerator: string;
		cause: unknown;
	}) => ({
		message: `Failed to unregister global shortcut '${accelerator}': ${extractErrorMessage(cause)}`,
		accelerator,
		cause,
	}),
	UnregisterAllFailed: ({ cause }: { cause: unknown }) => ({
		message: `Failed to unregister all global shortcuts: ${extractErrorMessage(cause)}`,
		cause,
	}),
});
type ShortcutError = InferErrors<typeof ShortcutError>;

async function registerShortcut({
	accelerator,
	callback,
	on,
}: {
	accelerator: Accelerator;
	callback: (state: ShortcutEventState) => void;
	on: ShortcutEventState[];
}): Promise<Result<void, InvalidAcceleratorError | ShortcutError>> {
	const { error: unregisterError } = await unregisterShortcut(accelerator);
	if (unregisterError) return Err(unregisterError);

	if (!isValidElectronAccelerator(accelerator)) {
		return AcceleratorError.InvalidFormat({ accelerator });
	}

	const { error: registerError } = await tryAsync({
		try: () =>
			tauriRegister(accelerator, (event) => {
				if (on.includes(event.state)) callback(event.state);
			}),
		catch: (error) =>
			ShortcutError.RegisterFailed({ accelerator, cause: error }),
	});
	// Tauri's platform layer sometimes returns "RegisterEventHotKey failed"
	// even after a successful registration. We swallow that error to avoid
	// an unhelpful toast; other valid shortcuts still register.
	if (registerError) {
		if (registerError.message.includes('RegisterEventHotKey failed')) {
			return Ok(undefined);
		}
		return Err(registerError);
	}
	return Ok(undefined);
}

async function unregisterShortcut(
	accelerator: Accelerator,
): Promise<Result<void, ShortcutError>> {
	const isRegistered = await tauriIsRegistered(accelerator);
	if (!isRegistered) return Ok(undefined);

	return tryAsync({
		try: () => tauriUnregister(accelerator),
		catch: (error) =>
			ShortcutError.UnregisterFailed({ accelerator, cause: error }),
	});
}

// autostart ---------------------------------------------------------
const AutostartError = defineErrors({
	CheckFailed: ({ cause }: { cause: unknown }) => ({
		message: `Failed to check autostart: ${extractErrorMessage(cause)}`,
		cause,
	}),
	EnableFailed: ({ cause }: { cause: unknown }) => ({
		message: `Failed to enable autostart: ${extractErrorMessage(cause)}`,
		cause,
	}),
	DisableFailed: ({ cause }: { cause: unknown }) => ({
		message: `Failed to disable autostart: ${extractErrorMessage(cause)}`,
		cause,
	}),
});

// Public namespaces ------------------------------------------------
// Each capability picks ONE shape per method: TanStack where reactivity,
// caching, or invalidation is the point; plain Result functions otherwise.
// One canonical call shape per leaf; no `tauri.X.Y` vs `tauri.rpc.X.Y`
// duplication.

const autostart = {
	isEnabled: defineQuery({
		queryKey: autostartKeys.isEnabled,
		queryFn: () =>
			tryAsync({
				try: () => isAutostartEnabled(),
				catch: (error) => AutostartError.CheckFailed({ cause: error }),
			}),
		initialData: false,
	}),
	enable: defineMutation({
		mutationKey: autostartKeys.enable,
		mutationFn: () =>
			tryAsync({
				try: () => enableAutostart(),
				catch: (error) => AutostartError.EnableFailed({ cause: error }),
			}),
		onSettled: () =>
			queryClient.invalidateQueries({ queryKey: autostartKeys.isEnabled }),
	}),
	disable: defineMutation({
		mutationKey: autostartKeys.disable,
		mutationFn: () =>
			tryAsync({
				try: () => disableAutostart(),
				catch: (error) => AutostartError.DisableFailed({ cause: error }),
			}),
		onSettled: () =>
			queryClient.invalidateQueries({ queryKey: autostartKeys.isEnabled }),
	}),
};

const tray = {
	setIcon: ({ icon }: { icon: WhisperingRecordingState }) =>
		tryAsync({
			try: async () => {
				const iconPath = await getIconPath(icon);
				if (!trayPromise) trayPromise = initTray();
				const t = await trayPromise;
				return t.setIcon(iconPath);
			},
			catch: (error) => TrayError.SetIcon({ cause: error }),
		}),
};

const globalShortcuts = {
	async registerCommand({
		command: cmd,
		// Parameter may contain legacy "CommandOrControl" syntax.
		// Legacy: "CommandOrControl+Shift+R" -> Modern: "Command+Shift+R"
		// (macOS) or "Control+Shift+R" (Windows/Linux).
		accelerator: legacyAcceleratorString,
	}: {
		command: Command;
		accelerator: Accelerator;
	}) {
		const { commandCallbacks } = await import('$lib/commands');
		const accel = legacyAcceleratorString.replace(
			'CommandOrControl',
			IS_MACOS ? 'Command' : 'Control',
		) as Accelerator;
		return registerShortcut({
			accelerator: accel,
			callback: commandCallbacks[cmd.id],
			on: cmd.on,
		});
	},

	unregisterCommand: ({ accelerator }: { accelerator: Accelerator }) =>
		unregisterShortcut(accelerator),

	unregisterAll: () =>
		tryAsync({
			try: () => tauriUnregisterAll(),
			catch: (error) => ShortcutError.UnregisterAllFailed({ cause: error }),
		}),
};

// barrel ------------------------------------------------------------
// `tauriOnly` is the non-null namespace for `.tauri.ts` files. The
// `tauri` export widens it to `Tauri | null` so shared consumers narrow.
export const tauriOnly = {
	fs,
	permissions,
	window,
	tray,
	globalShortcuts,
	autostart,
};

/** Shape of the Tauri capability namespace (non-null). */
export type Tauri = typeof tauriOnly;

/**
 * The Tauri capability namespace, or `null` on web builds.
 * Doubles as the platform check: truthy means Tauri.
 */
export const tauri: Tauri | null = tauriOnly;
