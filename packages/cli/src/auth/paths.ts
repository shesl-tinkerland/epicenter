/**
 * Centralized path constants for the Epicenter CLI.
 *
 * Single source of truth for every file location under `~/.epicenter/`.
 * Auth lives globally (under `$EPICENTER_HOME`). Per-workspace persistence
 * is project-local now (see `persistencePath` from `@epicenter/workspace`);
 * materialization has always been project-local.
 *
 * Override the home directory by setting `$EPICENTER_HOME`.
 *
 * @example
 * ```typescript
 * import { epicenterPaths } from '@epicenter/cli';
 *
 * epicenterPaths.home()
 * // → '/Users/braden/.epicenter'
 *
 * epicenterPaths.authSessions()
 * // → '/Users/braden/.epicenter/auth/sessions.json'
 * ```
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

/** Resolve the Epicenter home directory. Not exported; use `epicenterPaths.home()`. */
function resolveHome(): string {
	return Bun.env.EPICENTER_HOME ?? join(homedir(), '.epicenter');
}

/**
 * Grouped path resolution for all files under `~/.epicenter/`.
 *
 * Each method calls `resolveHome()` directly (no `this` references), so
 * destructuring is safe: `const { persistence } = epicenterPaths`.
 */
export const epicenterPaths = {
	/**
	 * The Epicenter home directory.
	 *
	 * Resolution order: `$EPICENTER_HOME` env → `~/.epicenter/`.
	 * All other paths are relative to this.
	 *
	 * @example
	 * ```typescript
	 * const home = epicenterPaths.home();
	 * // → '/Users/braden/.epicenter'
	 * ```
	 */
	home() {
		return resolveHome();
	},

	/**
	 * Path to the auth sessions file.
	 *
	 * Stores server-keyed auth sessions (access tokens, encryption keys, user info)
	 * persisted by `epicenter auth login`. Created by `createSessionStore`.
	 *
	 * @example
	 * ```typescript
	 * epicenterPaths.authSessions()
	 * // → '/Users/braden/.epicenter/auth/sessions.json'
	 * ```
	 */
	authSessions() {
		return join(resolveHome(), 'auth', 'sessions.json');
	},
} as const;
