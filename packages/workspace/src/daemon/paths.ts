/**
 * Path builders for the long-lived `epicenter up` daemon.
 *
 * Pure helpers: no side effects, no directory creation. The `up` command
 * (Wave 5) owns the `mkdir`/`chmod` work; consumers here are free to call
 * these from anywhere without worrying about filesystem mutation.
 *
 * See spec: `20260426T235000-cli-up-long-lived-peer.md` § Socket location.
 */

import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Resolve the Epicenter home directory.
 *
 * Resolution order: `$EPICENTER_HOME` env, then `~/.epicenter/`. Mirrors
 * the resolution used by the CLI's auth/paths helper so daemon sockets and
 * logs land under the same root regardless of which package wrote them.
 */
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
