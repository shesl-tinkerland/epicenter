/**
 * Bind a Hono app to a unix socket via `Bun.serve`. Filesystem hardening
 * lives here; route definitions live in `app.ts`.
 *
 * - Parent directory `mkdirSync` (recursive) with mode `0700`.
 * - Socket file `chmod 0600` immediately after `Bun.serve` returns.
 * - `Bun.serve.stop()` auto-unlinks the socket file on graceful shutdown.
 *   {@link unlinkSocketFile} is for orphan-sweep paths only.
 *
 * Wire format and security model are deliberately internal; see
 * `specs/20260426T235000-cli-up-long-lived-peer.md` § "IPC wire protocol"
 * and § "Security model". The CLI is the only sanctioned client.
 */

import { chmodSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';

import type { Hono } from 'hono';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { type Result, tryAsync } from 'wellcrafted/result';

import { readMetadata, unlinkMetadata } from './metadata.js';

/** Public handle returned by {@link bindUnixSocket}. */
export type UnixSocketServer = { stop(): void };

/**
 * Tagged-error variants for daemon startup. `bindOrRecover` returns one of
 * these on failure; the `up` handler renders `error.message` to stderr and
 * exits 1.
 *
 * - `AlreadyRunning`: another daemon owns this dir's socket and answers ping.
 * - `BindFailed`: `Bun.serve` raised on an unrecoverable bind error
 *   (filesystem permission, missing parent dir we couldn't `mkdir`, etc.).
 *   Reserved for genuinely-unexpected failures; the recovery branch
 *   (orphan sweep + retry) handles the common stale-socket case.
 */
export const StartupError = defineErrors({
	AlreadyRunning: ({ pid }: { pid?: number }) => ({
		message: `daemon already running${pid !== undefined ? ` (pid=${pid})` : ''}`,
		pid,
	}),
	BindFailed: ({ cause }: { cause: unknown }) => ({
		message: `bind failed: ${extractErrorMessage(cause)}`,
		cause,
	}),
});
export type StartupError = InferErrors<typeof StartupError>;

/**
 * Bind `app.fetch` to a unix socket at `socketPath`. Returns the Bun
 * listener narrowed to `.stop()` so the daemon body owns lifecycle.
 */
export async function bindUnixSocket(
	socketPath: string,
	app: Hono,
): Promise<UnixSocketServer> {
	mkdirSync(dirname(socketPath), { recursive: true, mode: 0o700 });

	const server = Bun.serve({
		unix: socketPath,
		fetch: app.fetch,
	});

	chmodSync(socketPath, 0o600);

	return server;
}

/**
 * Bind, but recover from a stale socket left behind by a crashed
 * predecessor. The check is socket-first, not pid-first: a recycled pid
 * that isn't actually serving fails the ping, same as a dead pid.
 *
 *   1. Socket file absent: bind clean.
 *   2. Socket file present, ping answers: live daemon owns the dir;
 *      return `AlreadyRunning(pid)` from the metadata sidecar.
 *   3. Socket file present, ping silent: orphan from a crashed daemon.
 *      Sweep socket + metadata, then bind.
 *
 * `Bun.serve({ unix })` overwrites an existing socket file without
 * raising `EADDRINUSE`, so the "try-bind, recover on EADDRINUSE"
 * pattern from POSIX TCP doesn't apply here. The pre-ping is what
 * actually distinguishes a live daemon from an orphan.
 *
 * `ping` is injected so this module doesn't depend on `client.ts` (the
 * import cycle would be ugly) and tests can stub the probe.
 */
export async function bindOrRecover(
	socketPath: string,
	dir: string,
	app: Hono,
	ping: (sock: string, timeoutMs?: number) => Promise<boolean>,
): Promise<Result<UnixSocketServer, StartupError>> {
	if (existsSync(socketPath)) {
		if (await ping(socketPath, 250)) {
			return StartupError.AlreadyRunning({ pid: readMetadata(dir)?.pid });
		}
		unlinkSocketFile(socketPath);
		unlinkMetadata(dir);
	}
	return tryAsync({
		try: () => bindUnixSocket(socketPath, app),
		catch: (cause) => StartupError.BindFailed({ cause }),
	});
}

/**
 * Best-effort socket-file cleanup. `Bun.serve.stop()` already unlinks on
 * graceful shutdown; this is the manual sweep for orphan-detection paths
 * (the file may have been left behind by a crashed previous daemon).
 */
export function unlinkSocketFile(socketPath: string): void {
	if (existsSync(socketPath)) {
		try {
			unlinkSync(socketPath);
		} catch {
			// Best-effort cleanup; another process may have raced us.
		}
	}
}

