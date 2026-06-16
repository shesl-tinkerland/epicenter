/**
 * Daemon-side runtime types.
 *
 * `DaemonRuntime` is the contract every opened mount returns: async dispose
 * plus the local action registry the daemon serves. Collaborative mounts may
 * also expose a hosted `Collaboration` for identity, sync, peer
 * presence, and peer dispatch.
 *
 * `DaemonServedMount` is the narrowed mount-handler contract for the socket
 * app. `StartedMount` is the lifecycle-owning mount shape opened from a
 * configured mount factory.
 */

import type { Result } from 'wellcrafted/result';
import type { DispatchError, DispatchRequest } from '../document/dispatch.js';
import type { SyncStatus } from '../document/internal/sync-supervisor.js';
import type { Collaboration } from '../document/open-collaboration.js';
import type { Peer } from '../document/presence-protocol.js';
import type { ActionRegistry } from '../shared/actions.js';
import type { MaybePromise } from '../shared/types.js';

/**
 * Collaboration fields the daemon socket app reads while serving `/peers` and
 * peer `/run`.
 */
type DaemonServedCollaboration = {
	peers: {
		list(): Peer[];
	};
	status: SyncStatus;
	dispatch(req: DispatchRequest): Promise<Result<unknown, DispatchError>>;
};

/**
 * One mounted runtime as served by the daemon socket app.
 *
 * Full started mounts can pass through structurally, but mount handlers do
 * not depend on lifecycle fields such as async disposal.
 */
export type DaemonServedMount = {
	mount: string;
	runtime: {
		actions: ActionRegistry;
		collaboration?: DaemonServedCollaboration;
	};
};

/**
 * Fields the daemon looks at on each started runtime.
 */
export type DaemonRuntime = {
	/** Called by the daemon at exit. */
	[Symbol.asyncDispose](): MaybePromise<void>;

	/**
	 * The action registry this daemon serves locally. When `collaboration` is
	 * present, this must be the same registry handed to `openCollaboration`, so
	 * local runs, peer manifests, and inbound peer dispatch stay in lockstep.
	 */
	readonly actions: ActionRegistry;

	/**
	 * Optional hosted collaboration. Identity, sync status, live-node
	 * presence, and peer dispatch live here when the mount participates in a
	 * collaborative Yjs workspace.
	 */
	readonly collaboration?: Collaboration<ActionRegistry>;
};

/** One configured mount runtime hosted by the daemon. */
export type StartedMount = {
	mount: string;
	runtime: DaemonRuntime;
};
