import { defineMutation, defineQuery } from '$lib/rpc/client';
import { unreachable } from '$lib/services/_tauri-stub';
import type * as Tauri from './index.tauri';

/**
 * Web stub for the desktop RPC namespace. The real implementation lives
 * in `index.tauri.ts` and is bundled only into Tauri builds. This file
 * exists so static imports from web-bundled consumers (settings pages
 * with Tauri-gated sections, layout utilities that no-op on web)
 * resolve at `vite build` time.
 *
 * Each leaf is a real defineQuery/defineMutation whose fn is the shared
 * `unreachable` throw. Consumers gate on `window.__TAURI_INTERNALS__`
 * so the throws never fire on web. `satisfies typeof Tauri.desktopRpc`
 * gives drift protection: `unreachable` is `(...args: unknown[]) =>
 * never`, which is structurally assignable to any function shape, so
 * the only things this file has to keep in sync with the real impl are
 * the queryKey/mutationKey tuples. If a new mutation or query is added
 * to `index.tauri.ts`, the web build fails here.
 */

export const desktopRpc = {
	autostart: {
		isEnabled: defineQuery({
			queryKey: ['autostart', 'isEnabled'],
			queryFn: unreachable,
			initialData: false,
		}),
		enable: defineMutation({
			mutationKey: ['autostart', 'enable'] as const,
			mutationFn: unreachable,
		}),
		disable: defineMutation({
			mutationKey: ['autostart', 'disable'] as const,
			mutationFn: unreachable,
		}),
	},
	tray: {
		setTrayIcon: defineMutation({
			mutationKey: ['setTrayIcon', 'setTrayIcon'] as const,
			mutationFn: unreachable,
		}),
	},
	ffmpeg: {
		checkFfmpegInstalled: defineQuery({
			queryKey: ['ffmpeg.checkInstalled'],
			queryFn: unreachable,
		}),
	},
	globalShortcuts: {
		registerCommand: defineMutation({
			mutationKey: ['shortcuts', 'registerCommandGlobally'] as const,
			mutationFn: unreachable,
		}),
		unregisterCommand: defineMutation({
			mutationKey: ['shortcuts', 'unregisterCommandGlobally'] as const,
			mutationFn: unreachable,
		}),
		unregisterAll: defineMutation({
			mutationKey: ['shortcuts', 'unregisterAllGlobalShortcuts'] as const,
			mutationFn: unreachable,
		}),
	},
} satisfies typeof Tauri.desktopRpc;
