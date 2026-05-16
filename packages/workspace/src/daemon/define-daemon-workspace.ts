/**
 * `defineDaemonWorkspace`: typed entry contract for a folder-routed daemon
 * extension module. Each `workspaces/<route>/daemon.ts` default-exports one of
 * these; the host calls `open(ctx)` once on `epicenter daemon up`.
 *
 * The returned runtime shape matches `DaemonRuntime` so the socket app does
 * not branch on extension origin.
 *
 * See `specs/20260516T180000-folder-routed-daemon-extensions.md`.
 */

import type { AuthClient } from '@epicenter/auth';

import type { MaybePromise, ProjectDir } from '../shared/types.js';
import type { DaemonRuntime } from './types.js';

/**
 * Context handed to `open()` for one daemon extension. The host fills it in
 * from the discovered folder entry and the shared auth client.
 *
 * - `auth` is the shared machine auth client. The host owns its lifetime,
 *   and refuses to call `open` when auth is signed-out.
 * - `projectDir` is the resolved project root (same value the daemon lease
 *   owns). Disk-writing helpers like `yjsPath` derive every absolute path
 *   from it.
 * - `route` is the folder-derived route name. Pinned here so extensions do
 *   not re-encode the same string as a constant; error messages and logger
 *   names read it off the context.
 * - `clientId` is the deterministic Y.Doc clientID for this daemon
 *   (derived from `projectDir` so two daemons in different projects
 *   produce distinct update streams). Pass it to the workspace opener.
 * - `replicaId` is the conventional collaboration replicaId for the
 *   daemon side of this route (`<route>-daemon`). Pass it to
 *   `openCollaboration`.
 */
export type DaemonWorkspaceContext = {
	auth: AuthClient;
	projectDir: ProjectDir;
	route: string;
	clientId: number;
	replicaId: string;
};

/**
 * The module shape every daemon extension `daemon.ts` default-exports.
 *
 * `open(ctx)` opens long-lived resources and returns a `DaemonRuntime` that
 * the daemon socket app can serve immediately. The runtime owns its own async
 * dispose; the host calls it during shutdown or after a sibling open fails.
 */
export type DaemonWorkspaceModule<
	TRuntime extends DaemonRuntime = DaemonRuntime,
> = {
	open(ctx: DaemonWorkspaceContext): MaybePromise<TRuntime>;
};

/**
 * Define a daemon extension module. Pure identity at the value level; the
 * useful work is the type binding so extension `daemon.ts` files get
 * IntelliSense for the context fields and the runtime return shape.
 */
export function defineDaemonWorkspace<TRuntime extends DaemonRuntime>(
	module: DaemonWorkspaceModule<TRuntime>,
): DaemonWorkspaceModule<TRuntime> {
	return module;
}
