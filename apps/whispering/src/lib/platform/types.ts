/**
 * Platform seam contracts. Each `#platform/*` subpath (declared in
 * `apps/whispering/package.json` "imports") has a browser impl and a Tauri impl
 * that both conform to a type here, so the two stay in lockstep no matter which
 * one a given build or the type checker resolves. Consumers import the bare
 * `#platform/*` specifier; the build picks the impl (web uses `default`, the
 * browser file; Tauri activates the `tauri` condition).
 *
 * This file must stay free of `@tauri-apps/*` imports so it type-checks and
 * ships under the web (default) resolution.
 */

import type { Command } from '$lib/commands';
import type { KeyBinding } from '$lib/tauri/commands';

/**
 * Contract for `#platform/shortcuts`: the per-platform shortcut backend. The
 * desktop build drives system-global rdev bindings (device-config storage); the
 * web build drives in-app keydown shortcuts (workspace KV storage). Only one
 * runs per platform, so consumers call these names without branching on `tauri`.
 * The trigger dispatch itself converges in `dispatchCommandTrigger`; this owns
 * the binding configuration around it.
 */
export type Shortcuts = {
	/** Push every command's configured binding to this platform's backend. */
	sync(): Promise<void>;
	/** Restore every shortcut to its default binding, then re-sync. */
	reset(): void;
	/** A command's default binding, formatted for display (`''` when unbound). */
	defaultLabel(commandId: Command['id']): string;
	/**
	 * The command's *current* binding on this platform, formatted for display
	 * (`''` when unbound). The single owner of "what key is live for this
	 * command": display-only consumers (action cards, home-page hints) read this
	 * instead of reaching into platform storage and re-deriving the `tauri` branch.
	 */
	currentLabel(commandId: Command['id']): string;
	/**
	 * The command's current binding (`null` when unbound). What the recorder reads
	 * to show and prefill the binding, instead of reaching into platform storage
	 * and re-deriving the storage-key scheme the backend already owns.
	 */
	current(commandId: Command['id']): KeyBinding | null;
	/** Persist a binding for this command and push it to the platform runtime. */
	set(commandId: Command['id'], binding: KeyBinding): Promise<void>;
	/** Clear this command's binding and push the removal. */
	clear(commandId: Command['id']): Promise<void>;
	/**
	 * Why `binding` cannot be assigned to this command, or `null` when it is
	 * allowed. The policy is per-tier and lives in the backend: the in-app tier
	 * refuses an exact duplicate (its matcher fires every command whose set
	 * matches); the global tier refuses a reserved gesture or one that overlaps
	 * another (its matcher has no prefix resolution).
	 */
	findConflict(commandId: Command['id'], binding: KeyBinding): string | null;
};

/**
 * Contract for `#platform/os`: host-OS identity, resolved once per build target.
 * The Tauri build reads the real OS natively; the web build infers it from the
 * user agent. Only the two facts the app actually branches on are exposed.
 */
export type Os = {
	/**
	 * An Apple platform: macOS, iOS, or iPadOS. These share the Command (⌘)
	 * primary modifier and the Option-key character layout, which is what every
	 * keyboard call site branches on. On the desktop (Tauri) build this is
	 * exactly macOS, since whispering's desktop targets are macOS, Windows, and
	 * Linux; iOS only ever appears on the web.
	 */
	isApple: boolean;
	/** Desktop Linux, excluding Android. Gates the Linux-only VAD notice. */
	isLinux: boolean;
};
