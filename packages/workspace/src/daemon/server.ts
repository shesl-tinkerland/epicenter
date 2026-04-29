/**
 * Daemon server factory: build the workspace map, build the Hono app, and
 * bind a unix socket. The "build + bind" core extracted from the CLI's
 * `epicenter serve` command so any bun process (CLI, vault, embedded) can
 * stand up the daemon transport without depending on `@epicenter/cli`.
 *
 * Lifecycle (metadata sidecar, signal handlers, log routing, dispose
 * orchestration) stays with the caller. This factory owns only the two
 * pieces that have to live in the workspace package: the workspace
 * dispatch table and the unix-socket listener.
 *
 * See spec: `20260429T004302-workspace-as-daemon-transport.md` § Phase 2.
 */

import type { Result } from 'wellcrafted/result';

import { buildApp } from './app.js';
import { pingDaemon } from './client.js';
import { socketPathFor } from './paths.js';
import type { WorkspaceEntry } from './types.js';
import {
	bindOrRecover,
	type StartupError,
	type UnixSocketServer,
	unlinkSocketFile,
} from './unix-socket.js';

export type WorkspaceServerOptions = {
	/** Filesystem-resolved absolute path that scopes this daemon. */
	absDir: string;
	/**
	 * Pre-constructed workspace entries the daemon hosts. Each entry's
	 * `name` is the routing key the wire surface dispatches on (the `-w`
	 * flag at the CLI, the `workspace` field on `/list` and `/run`).
	 */
	workspaces: WorkspaceEntry[];
};

export type WorkspaceServer = {
	/** Filesystem path of the unix socket this server binds. */
	readonly socketPath: string;
	/**
	 * Bind the unix socket. On a stale socket left by a crashed predecessor
	 * the bind sweeps the orphan and retries; on a live daemon answering
	 * ping at the same path it returns `StartupError.AlreadyRunning`. Calls
	 * after a successful `listen()` are a no-op until `close()` runs.
	 */
	listen(): Promise<Result<UnixSocketServer, StartupError>>;
	/**
	 * Stop the bound listener. `Bun.serve.stop()` unlinks the socket file
	 * itself; this method also sweeps any leftover socket file as a guard
	 * for hard-error paths. Idempotent.
	 */
	close(): Promise<void>;
};

/**
 * Build a workspace dispatch table from `opts.workspaces`, return a handle
 * with a deferred `listen()`. The factory does not touch the filesystem
 * until `listen()` is called.
 */
export function createWorkspaceServer(
	opts: WorkspaceServerOptions,
): WorkspaceServer {
	const seen = new Set<string>();
	for (const entry of opts.workspaces) {
		if (seen.has(entry.name)) {
			throw new Error(
				`createWorkspaceServer: duplicate workspace name '${entry.name}'`,
			);
		}
		seen.add(entry.name);
	}

	const socketPath = socketPathFor(opts.absDir);
	const app = buildApp(opts.workspaces);

	let server: UnixSocketServer | undefined;

	return {
		socketPath,
		async listen() {
			const result = await bindOrRecover(
				socketPath,
				opts.absDir,
				app,
				pingDaemon,
			);
			if (result.error === null) server = result.data;
			return result;
		},
		async close() {
			if (server) {
				try {
					server.stop();
				} catch {
					// best-effort
				}
				server = undefined;
			}
			unlinkSocketFile(socketPath);
		},
	};
}
