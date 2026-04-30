/**
 * `connectDaemon` — front door for talking to a workspace hosted by a
 * running daemon. The single entry point shared by vault scripts and
 * every CLI command that dispatches a workspace action.
 *
 * Generic `W` is the in-process workspace shape (typically
 * `ReturnType<typeof openFuji>`); the runtime returns a `Remote<W>` proxy
 * backed by a unix-socket `DaemonClient`. `W` is type-only: no workspace
 * code runs in the caller process. `Remote<W>` filters `W` to its branded
 * `defineQuery` / `defineMutation` leaves and rewrites each into
 * `Promise<Result<_, _ | RpcError>>`.
 *
 * @example
 * ```ts
 * import { connectDaemon } from '@epicenter/workspace';
 * import type { openFuji } from '@epicenter/fuji/workspace';
 *
 * using fuji = await connectDaemon<ReturnType<typeof openFuji>>({
 *   id: 'epicenter.fuji',
 * });
 * await fuji.tables.entries.update({ id, tags: ['untagged'] });
 * ```
 *
 * Daemon-scope calls (peers, list across workspaces) live on `DaemonClient`
 * directly — construct one with `daemonClient(socketPathFor(absDir))` and
 * call `.peers()` / `.list()` against the same socket. They are not
 * reachable through this workspace handle.
 */

import type { ProjectDir } from '../shared/types.js';
import { DaemonError, daemonClient, pingDaemon } from '../daemon/client.js';
import { socketPathFor } from '../daemon/paths.js';
import { findEpicenterDir } from './find-epicenter-dir.js';
import { buildRemoteWorkspace } from './remote.js';
import type { Remote } from './remote-workspace-types.js';

/**
 * Connect to a workspace hosted by a running daemon.
 *
 * `id` is the workspace selector. Today the wire dispatches by the
 * human-facing `name` exported in `epicenter.config.ts` (per Phase 2's
 * pragmatic deviation); long-term this collapses to `ydoc.guid`. Either
 * way, the value is opaque to this function and threads through to the
 * remote-workspace proxy.
 *
 * `absDir` defaults to walking up from `process.cwd()` for an
 * `epicenter.config.ts` file or a `.epicenter/` directory.
 *
 * Throws `DaemonError.Required` if no daemon is listening on the
 * resolved socket. Start one with `epicenter serve`. There is no
 * auto-spawn: explicit lifecycle is the contract.
 */
export async function connectDaemon<W>({
	id,
	absDir = findEpicenterDir(process.cwd()),
}: {
	id: string;
	/**
	 * Project root. Defaults to the nearest ancestor of `process.cwd()`
	 * containing `epicenter.config.ts` or `.epicenter/`. Throws via
	 * `findEpicenterDir` if no such ancestor exists; pass an explicit
	 * `absDir` to opt out.
	 */
	absDir?: ProjectDir;
}): Promise<Remote<W>> {
	const socketPath = socketPathFor(absDir);
	if (!(await pingDaemon(socketPath))) {
		throw DaemonError.Required({ absDir, id }).error;
	}
	const client = daemonClient(socketPath);
	return buildRemoteWorkspace<W>(client, id);
}
