/**
 * Path builders for the daemon and per-workspace state.
 *
 * Two conventions:
 *   per-user (sockets, logs): `~/.epicenter/...`
 *   per-workspace (SQLite):    `<absDir>/.epicenter/...`
 *
 * Pure helpers: no side effects, no directory creation. The `serve` command
 * owns the `mkdir`/`chmod` work; consumers here are free to call these from
 * anywhere without worrying about filesystem mutation.
 */

import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** `$EPICENTER_HOME` env, then `~/.epicenter/`. */
function epicenterHome(): string {
	return Bun.env.EPICENTER_HOME ?? join(homedir(), '.epicenter');
}

/**
 * Resolve the runtime directory for daemon sockets and metadata.
 *
 * - Linux with `XDG_RUNTIME_DIR` → `$XDG_RUNTIME_DIR/epicenter` (tmpfs,
 *   reboot-cleaned by the OS).
 * - macOS / Windows / Linux without XDG → `~/.epicenter/run` (orphan
 *   cleanup at `up` startup substitutes for the missing tmpfs reset).
 */
export function runtimeDir(): string {
	if (process.env.XDG_RUNTIME_DIR) {
		return join(process.env.XDG_RUNTIME_DIR, 'epicenter');
	}
	return join(epicenterHome(), 'run');
}

/**
 * Stable hash of an absolute, fs-resolved `--dir` path.
 *
 * Truncated to 16 hex chars (64 bits) so the resulting socket path stays
 * comfortably under the 104-char Unix-socket limit on macOS. Symlinks are
 * resolved via `realpathSync` so two equivalent paths always hash the same.
 * The dir must exist; every production caller hashes a `--dir` that
 * `loadConfig` has already accepted, so this contract is safe to enforce.
 */
export function dirHash(dir: string): string {
	return createHash('sha256').update(realpathSync(dir)).digest('hex').slice(0, 16);
}

/** Unix-socket path for the daemon serving `dir`. */
export function socketPathFor(dir: string): string {
	return join(runtimeDir(), `${dirHash(dir)}.sock`);
}

/** Metadata JSON sidecar (`pid`, `deviceId`, `workspace`, ...) for the daemon serving `dir`. */
export function metadataPathFor(dir: string): string {
	return join(runtimeDir(), `${dirHash(dir)}.meta.json`);
}

/**
 * Log file for the daemon serving `dir`.
 *
 * Always lives under `~/.epicenter/log/` (persistent), never tmpfs, so
 * the operator can read post-mortem logs after a crash or reboot.
 */
export function logPathFor(dir: string): string {
	return join(epicenterHome(), 'log', `${dirHash(dir)}.log`);
}

/**
 * Path to a workspace's SQLite persistence file.
 *
 * Convention: `<absDir>/.epicenter/persistence/<workspaceId>.db`.
 * `absDir` is the project root (where `epicenter.config.ts` lives);
 * `workspaceId` is `ws.ydoc.guid`.
 *
 * @example
 * ```ts
 * persistencePath('/Users/braden/Code/vault', 'epicenter.fuji')
 * // → '/Users/braden/Code/vault/.epicenter/persistence/epicenter.fuji.db'
 * ```
 */
export function persistencePath(absDir: string, workspaceId: string): string {
	return join(absDir, '.epicenter', 'persistence', `${workspaceId}.db`);
}

/**
 * Path to a workspace's SQLite materializer mirror file.
 *
 * Convention: `<absDir>/.epicenter/mirrors/<workspaceId>.db`. The daemon's
 * `attachSqliteMaterializer` writes this file (in WAL journal mode); script
 * peers open the same path read-only via `attachSqliteMirror`.
 *
 * Distinct from `persistencePath`: persistence holds the raw Y.Doc update
 * log (the canonical CRDT history); the mirror holds typed rows + FTS5
 * indexes derived from that history. Different shape, different concurrency
 * profile, different consumers.
 *
 * @example
 * ```ts
 * mirrorPathFor('/Users/braden/Code/vault', 'epicenter.fuji')
 * // → '/Users/braden/Code/vault/.epicenter/mirrors/epicenter.fuji.db'
 * ```
 */
export function mirrorPathFor(absDir: string, workspaceId: string): string {
	return join(absDir, '.epicenter', 'mirrors', `${workspaceId}.db`);
}

/**
 * Root directory for a workspace's markdown materializer tree.
 *
 * Convention: `<absDir>/.epicenter/markdown/<workspaceId>/`. The daemon's
 * `attachMarkdownMaterializer` writes per-table subdirectories of `.md`
 * files under this root; script peers walk the same tree read-only via
 * `attachMarkdownMirror`.
 *
 * @example
 * ```ts
 * markdownPathFor('/Users/braden/Code/vault', 'epicenter.fuji')
 * // → '/Users/braden/Code/vault/.epicenter/markdown/epicenter.fuji'
 * ```
 */
export function markdownPathFor(absDir: string, workspaceId: string): string {
	return join(absDir, '.epicenter', 'markdown', workspaceId);
}
