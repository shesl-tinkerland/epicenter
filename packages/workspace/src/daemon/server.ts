/**
 * Daemon server starter: build the app for one started mount and bind a unix
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
import { unlinkSocketFile } from './runtime-files.js';
import { StartupError } from './startup-errors.js';
import type { DaemonServedMount } from './types.js';
import { bindUnixSocket } from './unix-socket.js';

export type DaemonServerOptions = {
	/** Already-claimed daemon lease. */
	lease: DaemonLease;
	/** Mount served by the unix-socket app. */
	mount: DaemonServedMount;
};

function createDaemonServer({
	server,
	socketPath,
}: {
	server: ReturnType<typeof bindUnixSocket>;
	socketPath: string;
}) {
	let isClosed = false;
	return {
		/** Filesystem path of the unix socket this server binds. */
		socketPath,
		/**
		 * Stop the bound listener. `Bun.serve.stop()` unlinks the socket file
		 * itself; this method also sweeps any leftover socket file as a guard
		 * for hard-error paths. Idempotent.
		 */
		async close() {
			if (isClosed) return;
			isClosed = true;
			await tryAsync({
				try: () => server.stop(true),
				catch: () => Ok(undefined),
			});
			unlinkSocketFile(socketPath);
		},
	};
}

export type DaemonServer = ReturnType<typeof createDaemonServer>;

/**
 * Start a daemon server for one already-started mount. The caller must claim the
 * daemon lease before mount startup; this function owns only socket binding.
 * Mount names are validated upstream by `openEpicenterRoot` before any mount
 * opens, so by the time a mount reaches here it is already known-good.
 *
 * The lease (`lease.ts`) is the sole ownership primitive: holding it means no
 * other daemon is live, so any leftover socket file is stale and `Bun.serve`
 * clobbers it on bind. There is no socket-liveness pre-check.
 */
export async function startDaemonServer({
	lease,
	mount,
}: DaemonServerOptions): Promise<Result<DaemonServer, StartupError>> {
	const { socketPath } = lease;
	const app = buildDaemonApp(mount);
	const bindResult = trySync({
		try: () => bindUnixSocket({ socketPath, fetch: app.fetch }),
		catch: (cause) => StartupError.BindFailed({ cause }),
	});
	if (bindResult.error !== null) return bindResult;

	const server = bindResult.data;
	return Ok(createDaemonServer({ server, socketPath }));
}
