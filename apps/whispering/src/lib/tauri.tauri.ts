/**
 * Tauri-only capability namespace. Everything that requires the Tauri
 * runtime lives in this file: fs, permissions, window, tray,
 * globalShortcuts, autostart. The subset that needs TanStack caching,
 * error transformation, or invalidation is exposed in the same shape
 * (no sub-namespace), with each leaf picking one canonical call form.
 *
 * Two files, one import path (`#platform/tauri`, declared in package.json
 * "imports"):
 *
 *     this file                              -> Tauri build (`tauri` condition)
 *     `./tauri.browser.ts` (exports `null`)  -> web build (`default`)
 *
 * Both files annotate the export `: Tauri | null` and export the `Tauri`
 * type, so consumers always see the full shape regardless of which one
 * resolves.
 *
 * Two patterns, one for each use case:
 *
 *     import { tauri } from '#platform/tauri';
 *     if (tauri) await tauri.fs.pathsToFiles(paths);
 *     // or
 *     await tauri?.fs.pathsToFiles(paths);
 *
 *     // Inside *.tauri.ts files only (build guarantees Tauri runtime).
 *     // `tauriOnly` is imported directly, not through the `#platform/tauri`
 *     // seam, which resolves to `null` on web and does not export it:
 *     import { tauriOnly } from '$lib/tauri.tauri';
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
import { exit } from '@tauri-apps/plugin-process';
import mime from 'mime';
import { defineErrors, extractErrorMessage } from 'wellcrafted/error';
import { Ok, tryAsync } from 'wellcrafted/result';
import { os } from '#platform/os';
import { goto } from '$app/navigation';
import type { ShortcutEventState } from '$lib/commands';
import type { WhisperingRecordingState } from '$lib/constants/audio';
import { defineMutation, defineQuery, queryClient } from '$lib/rpc/client';
import { autostartKeys } from '$lib/tauri/autostart-keys';
import type {
	CommandBinding,
	KeyBinding,
	MediaPlayer,
} from '$lib/tauri/commands';
import { commands, events } from '$lib/tauri/commands';

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
			if (!os.isApple) return Ok(true);
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
			if (!os.isApple) return Ok(true);
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
			if (!os.isApple) return Ok(undefined);
			const { error } = await commands.openAccessibilitySettings();
			if (error !== null) {
				return PermissionsError.OpenAccessibilitySettings({ cause: error });
			}
			return Ok(undefined);
		},
	},

	microphone: {
		async check() {
			if (!os.isApple) return Ok(true);
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
			if (!os.isApple) return Ok(true);
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
// The desktop trigger backend is the rdev listener in `src-tauri/src/keyboard`.
// It emits a `{ commandId, state }` event on every binding transition; we push
// the user's bindings down with `set_keyboard_shortcuts` and dispatch the
// events back into the command layer (the single convergence point). No
// accelerator strings cross this boundary: the registrar parses them to
// `KeyBinding` before pushing (see `register-commands.ts`). The trigger and
// capture topics are the generated `events.shortcutTriggerEvent` /
// `events.shortcutCaptureEvent`, so no topic string is mirrored here.

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
	/**
	 * Replace the full set of registered global shortcuts on the rdev backend.
	 * The registrar computes the complete list from device-config and pushes it
	 * on startup and on every change; replace-all keeps the FE the single source
	 * of truth with no add/remove bookkeeping.
	 */
	setBindings: (bindings: CommandBinding[]) =>
		commands.setKeyboardShortcuts(bindings),

	/**
	 * Start the rdev listener (idempotent). The caller gates this on "global
	 * shortcuts are allowed": on macOS once Accessibility is granted, on other
	 * desktops at launch. Returns the outcome so the caller can tell the user
	 * when shortcuts are unavailable (Wayland) instead of failing silently.
	 */
	start: () => commands.startKeyboardListener(),

	/**
	 * Subscribe to the rdev trigger event and dispatch each into the command
	 * layer, filtered by the command's `on` array. Returns the unlisten fn. The
	 * `on` filter is the same gate the old plugin registrar applied; keeping it
	 * here leaves `commands.ts` as the single convergence point.
	 */
	startListening: async () => {
		const { commandCallbacks, commands: commandList } = await import(
			'$lib/commands'
		);
		const onById = new Map<string, ShortcutEventState[]>(
			commandList.map((command) => [command.id, command.on]),
		);
		return events.shortcutTriggerEvent.listen(
			({ payload: { commandId, state } }) => {
				const on = onById.get(commandId);
				const callback =
					commandCallbacks[commandId as keyof typeof commandCallbacks];
				if (on?.includes(state) && callback) callback(state);
			},
		);
	},

	/**
	 * Enter or leave binding-capture mode. While capturing, the listener streams
	 * the held combo on the capture event (see `listenForCapture`) instead of
	 * firing command triggers, so the settings recorder can record Fn and
	 * physical-key bindings the webview cannot see.
	 */
	setCapturing: (capturing: boolean) =>
		commands.setKeyboardCapturing(capturing),

	/**
	 * Subscribe to the capture event. The listener emits the currently-held
	 * combo as a `KeyBinding` on every change while capturing; the recorder
	 * accumulates them and commits on release. Returns the unlisten fn.
	 */
	listenForCapture: (onCombo: (binding: KeyBinding) => void) =>
		events.shortcutCaptureEvent.listen(({ payload }) =>
			onCombo(payload.binding),
		),
};

// media -------------------------------------------------------------
const media = {
	pause: () => commands.pauseActiveMedia(),
	resume: (players: MediaPlayer[]) => commands.resumeMedia(players),
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
	media,
};

/** Shape of the Tauri capability namespace (non-null). */
export type Tauri = typeof tauriOnly;

/**
 * The Tauri capability namespace, or `null` on web builds.
 * Doubles as the platform check: truthy means Tauri.
 */
export const tauri: Tauri | null = tauriOnly;
