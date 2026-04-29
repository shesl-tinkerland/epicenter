/**
 * Server metadata sidecar: the JSON-on-disk record that lets `bindOrRecover`
 * surface a useful "already running (pid=X)" error when a second `serve`
 * tries to take the same socket.
 *
 * One `<runtimeDir>/<dirHash>.meta.json` per running server. Written once at
 * startup, unlinked at clean shutdown. Stale-socket recovery in
 * `unix-socket.ts` trusts the socket itself (ping it, recover if dead),
 * not the pid in this file; pid is for human-facing diagnostics only.
 */

import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';

import { createLogger } from 'wellcrafted/logger';

import { metadataPathFor } from './paths.js';

const log = createLogger('workspace/daemon/metadata');

/**
 * On-disk shape of `<dirHash>.meta.json`.
 *
 * `dir` is stored as the absolute, fs-resolved path so two cwd-relative
 * `--dir` arguments resolving to the same workspace match.
 */
export type DaemonMetadata = {
	pid: number;
	/** Absolute, fs-resolved `--dir` path. */
	dir: string;
};

/** Read metadata for `dir`, or `null` if the sidecar is absent or unreadable. */
export function readMetadata(dir: string): DaemonMetadata | null {
	const path = metadataPathFor(dir);
	if (!existsSync(path)) return null;
	try {
		const raw = readFileSync(path, 'utf8');
		return JSON.parse(raw) as DaemonMetadata;
	} catch (cause) {
		log.debug('failed to read server metadata', { path, cause });
		return null;
	}
}

/** Write metadata for `dir` atomically (single-writer; the server owns it). */
export function writeMetadata(dir: string, meta: DaemonMetadata): void {
	const path = metadataPathFor(dir);
	writeFileSync(path, `${JSON.stringify(meta, null, 2)}\n`, { mode: 0o600 });
}

/** Best-effort unlink of the metadata sidecar; silent if already gone. */
export function unlinkMetadata(dir: string): void {
	const path = metadataPathFor(dir);
	if (!existsSync(path)) return;
	try {
		unlinkSync(path);
	} catch (cause) {
		log.debug('failed to unlink server metadata', { path, cause });
	}
}
