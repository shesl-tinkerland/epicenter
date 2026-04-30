/**
 * Filesystem identifiers shared between the daemon, the CLI, and any
 * package that needs to discover or address an Epicenter project on disk.
 *
 * These values are part of the user-visible contract (the directory the
 * daemon and CLI agree on, the filename `findEpicenterDir` walks up looking
 * for) and must never drift between consumers.
 */

/**
 * Per-project directory name. Lives at `<projectDir>/.epicenter/` and
 * stores the workspace's per-app data layout: `yjs/`, `sqlite/`, `md/`.
 *
 * Discovered by `findEpicenterDir`'s upward walk and used by `yjsPath`,
 * `sqlitePath`, `markdownPath` to build per-workspace file paths.
 *
 * Distinct from {@link EPICENTER_USER_DIR_NAME} on purpose: same string
 * value today, but different concepts. Keep them split so a future rename
 * of one doesn't accidentally drag the other along.
 */
export const EPICENTER_PROJECT_DIR_NAME = '.epicenter';

/**
 * Per-user directory name. Lives at `~/.epicenter/` (or `$EPICENTER_HOME`)
 * and stores user-scoped runtime state: daemon sockets, metadata sidecars,
 * logs, and CLI auth sessions.
 *
 * Distinct from {@link EPICENTER_PROJECT_DIR_NAME} on purpose: same string
 * value today, different concept. The user-home version follows the
 * `~/.<app>/` convention for CLI tools; the project version is a local
 * data folder that lives alongside source.
 */
export const EPICENTER_USER_DIR_NAME = '.epicenter';

/**
 * Workspace config filename. Both `findEpicenterDir` (project-root walk)
 * and `loadConfig` (CLI module loader) hard-code this name; centralizing
 * it keeps the daemon's "no config" error and the CLI's import path in
 * lockstep.
 */
export const CONFIG_FILENAME = 'epicenter.config.ts';
