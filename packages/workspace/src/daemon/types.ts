/**
 * Daemon-side served types: the narrowed mount-handler contract the socket app
 * reads. The mount's own runtime shape (`DaemonRuntime`) and the lifecycle-owning
 * `StartedMount` live with the rest of the mount contract in `../mount/contract.js`.
 */

import type { Result } from 'wellcrafted/result';
import type { DispatchError, DispatchRequest } from '../document/dispatch.js';
import type { SyncStatus } from '../document/internal/sync-supervisor.js';
import type { PresenceDevice } from '../document/presence-protocol.js';
import type { ActionRegistry } from '../shared/actions.js';

/**
 * Collaboration fields the daemon socket app reads while serving `/peers`,
 * `/list`, and `/run`.
 */
type DaemonServedCollaboration<
	TActions extends ActionRegistry = ActionRegistry,
> = {
	actions: TActions;
	devices: {
		list(): PresenceDevice[];
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
export type DaemonServedMount<
	TActions extends ActionRegistry = ActionRegistry,
> = {
	mount: string;
	runtime: {
		collaboration: DaemonServedCollaboration<TActions>;
	};
};
