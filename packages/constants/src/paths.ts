/**
 * Filesystem identifiers shared between the daemon, the CLI, and any
 * package that needs to discover or address an Epicenter project on disk.
 *
 * These values are part of the user-visible contract (the directory the
 * daemon and CLI agree on, the filename `findEpicenterDir` walks up looking
 * for) and must never drift between consumers.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * The hidden directory name used in both the user home and the project root.
 *
 * Private on purpose: callers should resolve a full path via
 * {@link epicenterHome} or {@link epicenterProjectDir}, not concatenate the
 * literal themselves. Same name in both locations because it's named after
 * the app; what differs is *where* it lives, which the helpers express.
 */
const EPICENTER_DIR_NAME = '.epicenter';

/**
 * Per-user directory for runtime state: daemon sockets, metadata sidecars,
 * logs, and CLI auth sessions.
 *
 * Resolves `$EPICENTER_HOME` first, then falls back to `~/.epicenter/`.
 */
export function epicenterHome(): string {
	return process.env.EPICENTER_HOME ?? join(homedir(), EPICENTER_DIR_NAME);
}

/**
 * Per-project directory under `<projectDir>/.epicenter/`. Stores the
 * workspace's per-app data layout: `yjs/`, `sqlite/`, `md/`.
 *
 * Discovered by `findEpicenterDir`'s upward walk and used by `yjsPath`,
 * `sqlitePath`, `markdownPath` to build per-workspace file paths.
 */
export function epicenterProjectDir(projectDir: string): string {
	return join(projectDir, EPICENTER_DIR_NAME);
}

/**
 * Workspace config filename. Both `findEpicenterDir` (project-root walk)
 * and `loadConfig` (CLI module loader) hard-code this name; centralizing
 * it keeps the daemon's "no config" error and the CLI's import path in
 * lockstep.
 */
export const CONFIG_FILENAME = 'epicenter.config.ts';
