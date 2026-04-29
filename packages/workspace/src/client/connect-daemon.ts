/**
 * `connectDaemon` — front door for talking to a workspace hosted by a
 * running daemon. The single entry point shared by vault scripts and
 * (in Phase 7) every CLI command that dispatches a workspace action.
 *
 * Generic `T` is the workspace builder function (e.g. `typeof openFuji`);
 * its body never runs in the caller — TypeScript reads `ReturnType<T>` at
 * compile time only, and the runtime returns a `RemoteWorkspace<...>`
 * proxy backed by a unix-socket `DaemonClient`.
 *
 * @example
 * ```ts
 * import { connectDaemon } from '@epicenter/workspace';
 * import { openFuji } from '@epicenter/fuji/workspace';
 *
 * using fuji = await connectDaemon<typeof openFuji>({ id: 'epicenter.fuji' });
 * await fuji.actions.entries.update({ id, tags: ['untagged'] });
 * ```
 *
 * Phase 6 of `specs/20260429T004302-workspace-as-daemon-transport.md`.
 */

import { DaemonError, daemonClient, pingDaemon } from '../daemon/client.js';
import { socketPathFor } from '../daemon/paths.js';
import { findEpicenterDir } from './find-epicenter-dir.js';
import { buildRemoteWorkspace } from './remote.js';
import type { RemoteWorkspace } from './remote-workspace-types.js';

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
export async function connectDaemon<T extends (...args: any[]) => any>({
	id,
	absDir = findEpicenterDir(process.cwd()),
}: {
	id: string;
	absDir?: string;
}): Promise<RemoteWorkspace<ReturnType<T>>> {
	const socketPath = socketPathFor(absDir);
	if (!(await pingDaemon(socketPath))) {
		throw DaemonError.Required({ absDir, id }).error;
	}
	const client = daemonClient(socketPath);
	return buildRemoteWorkspace<ReturnType<T>>(client, id);
}
