/**
 * Daemon-side types describing the shape of a hosted daemon runtime.
 *
 * `DaemonRouteDefinition` is the config-time contract: a delayed route starter
 * with its own route name. `DaemonRuntime` is the runtime contract every
 * started daemon route has to satisfy: async dispose plus the hosted
 * `Collaboration<TActions>` that owns identity, actions, sync, and peers.
 *
 * `DaemonServedRoute` is the narrowed route handler contract for the socket
 * app. `StartedDaemonRoute` is the lifecycle-owning route shape opened by the
 * CLI's config loader from the default `{ daemon: { routes } }` export in
 * `epicenter.config.ts`.
 */

import type { AuthClient } from '@epicenter/auth';
import type { Result } from 'wellcrafted/result';
import type { SyncStatus } from '../document/internal/sync-supervisor.js';
import type { Collaboration } from '../document/open-collaboration.js';
import type { PresenceEntry } from '../document/presence.js';
import type { DispatchError } from '../document/rpc.js';
import type { ActionRegistry } from '../shared/actions.js';
import type { MaybePromise, ProjectDir } from '../shared/types.js';

export type DaemonRouteContext = {
	projectDir: ProjectDir;
	route: string;
	auth: AuthClient;
};

/**
 * Collaboration fields the daemon socket app reads while serving `/peers`,
 * `/list`, and `/run`.
 */
export type DaemonServedCollaboration<
	TActions extends ActionRegistry = ActionRegistry,
> = {
	actions: TActions;
	peers: {
		list(): PresenceEntry[];
	};
	status: SyncStatus;
	dispatch(
		action: string,
		input: unknown,
		options: { to: string; signal: AbortSignal },
	): Promise<Result<unknown, DispatchError>>;
};

/**
 * One routed runtime as served by the daemon socket app.
 *
 * Full started routes can pass through structurally, but route handlers do not
 * depend on lifecycle fields such as async disposal.
 */
export type DaemonServedRoute<
	TActions extends ActionRegistry = ActionRegistry,
> = {
	route: string;
	runtime: {
		collaboration: DaemonServedCollaboration<TActions>;
	};
};

/**
 * Fields the daemon looks at on each started runtime.
 */
export type DaemonRuntime<TActions extends ActionRegistry = ActionRegistry> = {
	/** Called by the daemon at exit. */
	[Symbol.asyncDispose](): MaybePromise<void>;

	/**
	 * The hosted collaboration. Identity, action registry, sync status, and
	 * the peers surface for cross-route dispatch all live here.
	 */
	readonly collaboration: Collaboration<TActions>;
};

export type DaemonRouteDefinition<
	TRuntime extends DaemonRuntime = DaemonRuntime,
> = {
	route: string;
	start(options: DaemonRouteContext): MaybePromise<TRuntime>;
};

export type EpicenterConfig = {
	daemon: {
		routes: readonly DaemonRouteDefinition[];
	};
};

export function defineConfig(config: EpicenterConfig): EpicenterConfig {
	return config;
}

/** One routed daemon runtime hosted by the daemon. */
export type StartedDaemonRoute = {
	route: string;
	runtime: DaemonRuntime;
};
