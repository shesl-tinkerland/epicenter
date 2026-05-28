/**
 * Daemon server starter: build the app for started mounts and bind a unix
 * socket. The "build + bind" core extracted from the CLI's
 * `epicenter daemon up` command so any bun process (CLI, vault, embedded) can
 * stand up the daemon transport without depending on `@epicenter/cli`.
 *
 * Lifecycle (metadata sidecar, signal handlers, log routing, dispose
 * orchestration) stays with the caller. This starter owns only the two
 * pieces that have to live in the workspace package: mount dispatch and the
 * unix-socket listener.
 *
 * See spec: `20260429T004302-workspace-as-daemon-transport.md` § Phase 2.
 */

import { Ok, type Result, tryAsync, trySync } from 'wellcrafted/result';

import { buildDaemonApp } from './app.js';
import type { DaemonLease } from './lease.js';
import { validateMountNames } from './mount-validation.js';
import { unlinkSocketFile } from './runtime-files.js';
import { StartupError } from './startup-errors.js';
import type { DaemonServedMount } from './types.js';
import { bindUnixSocket } from './unix-socket.js';

export type DaemonServerOptions = {
	/** Already-claimed project daemon lease. */
	lease: DaemonLease;
	/** Mounts served by the unix-socket app. */
	mounts: readonly DaemonServedMount[];
};

export type DaemonServer = {
	/** Filesystem path of the unix socket this server binds. */
	readonly socketPath: string;
	/**
	 * Stop the bound listener. `Bun.serve.stop()` unlinks the socket file
	 * itself; this method also sweeps any leftover socket file as a guard
	 * for hard-error paths. Idempotent.
	 */
	close(): Promise<void>;
};

/**
 * Start a daemon server for already-started mounts. The caller must claim the
 * daemon lease before mount startup; this function owns only mount-name
 * validation and socket binding.
 *
 * The lease (`lease.ts`) is the sole ownership primitive: holding it means no
 * other daemon is live, so any leftover socket file is stale and `Bun.serve`
 * clobbers it on bind. There is no socket-liveness pre-check.
 */
export async function startDaemonServer({
	lease,
	mounts,
}: DaemonServerOptions): Promise<Result<DaemonServer, StartupError>> {
	const { socketPath } = lease;
	const issue = validateMountNames(mounts.map((entry) => entry.mount));
	if (issue !== null) {
		return StartupError.MountNameRejected(issue);
	}

	const app = buildDaemonApp(mounts);
	const bindResult = trySync({
		try: () => bindUnixSocket({ socketPath, fetch: app.fetch }),
		catch: (cause) => StartupError.BindFailed({ cause }),
	});
	if (bindResult.error !== null) return bindResult;

	const server = bindResult.data;
	let isClosed = false;

	return Ok({
		socketPath,
		async close() {
			if (isClosed) return;
			isClosed = true;
			await tryAsync({
				try: () => server.stop(true),
				catch: () => Ok(undefined),
			});
			unlinkSocketFile(socketPath);
		},
	});
}
