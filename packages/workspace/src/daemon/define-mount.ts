/**
 * `defineMount`: the entry contract for an app mount inside the daemon.
 *
 * `epicenter.config.ts` default-exports one `Mount`. The mount carries its own
 * canonical `name`, which becomes the CLI action prefix (`<name>.<action_key>`)
 * and is propagated into the mount context so handlers can use it for logging.
 *
 * The host calls `open(ctx)` once on `epicenter daemon up`. A mount can do one
 * of two things:
 *
 *   - return a `DaemonRuntime` (`actions`, optionally `collaboration`), or
 *   - return `inactive(reason)` to say "I cannot run right now," typically
 *     because it needs a signed-in `session` and there is none.
 *
 * There is no `local` vs `collaborative` kind. The context carries the Epicenter
 * root, the mount name, a durable node id, and a nullable `session`. A purely
 * local mirror ignores the session, a mount that wants the peer plane (presence
 * + remote dispatch) uses its socket. The session is `null` when machine auth is
 * signed out, so the logged-out case is always in front of the author.
 *
 * Most mounts need a session, so they declare with `defineSessionMount` and get
 * a guaranteed-non-null `session` plus an automatic `inactive` when signed out.
 */

import type { OwnerId } from '@epicenter/identity';
import type { NodeId } from '../document/node-id.js';
import type {
	OnReconnectSignal,
	OpenWebSocketFn,
} from '../document/open-collaboration.js';
import type {
	AuthedFetch,
	EpicenterRoot,
	MaybePromise,
} from '../shared/types.js';
import type { DaemonRuntime } from './types.js';

/**
 * The signed-in capability kit: everything a mount needs that only exists once
 * machine auth is signed in. Built once per Epicenter root for its mount;
 * `null` on the context while signed out.
 *
 * - `ownerId` is the workspace owner the daemon syncs as.
 * - `openWebSocket` / `onReconnectSignal` / `fetch` are the auth-owned transport
 *   refs forwarded into `openCollaboration` for sync, presence, and dispatch,
 *   and into one-shot HTTP reads.
 */
export type MountSession = {
	readonly ownerId: OwnerId;
	readonly openWebSocket: OpenWebSocketFn;
	readonly onReconnectSignal: OnReconnectSignal;
	readonly fetch: AuthedFetch;
};

/**
 * Context handed to every `open()`.
 *
 * - `epicenterRoot` is the resolved Epicenter root (the folder that holds
 *   `epicenter.config.ts`). Disk-writing helpers derive every absolute path
 *   from it.
 * - `mount` is the canonical mount name (`Mount.name`), pinned so handlers
 *   share one identifier with logs and local cache keys. It is a label, not an
 *   identity seed: it never feeds the node id or the Y.Doc `clientID`.
 * - `nodeId` is the durable per-install identity (generated once and persisted
 *   under `.epicenter/`). It is the relay's routing id for presence and peer
 *   dispatch, and the seed for the Y.Doc `clientID`. Auth-independent: present
 *   even when signed out.
 * - `session` is the signed-in capability kit, or `null` when signed out.
 */
export type MountContext = {
	readonly epicenterRoot: EpicenterRoot;
	readonly mount: string;
	readonly nodeId: NodeId;
	readonly session: MountSession | null;
};

/** A `MountContext` whose `session` is known to be present. */
export type SessionMountContext = MountContext & {
	readonly session: MountSession;
};

/**
 * "I cannot run right now." A mount returns this from `open()` instead of a
 * runtime when a precondition (usually a signed-in `session`) is missing. The
 * daemon reports this as inactive; it is not a crash and does not abort startup.
 */
export type MountInactive = {
	readonly inactive: true;
	readonly reason: string;
};

/** Build the `MountInactive` signal an `open()` returns when it cannot run. */
export function inactive(reason: string): MountInactive {
	return { inactive: true, reason };
}

/** Narrow an `open()` result to the inactive branch. */
export function isInactive(
	result: DaemonRuntime | MountInactive,
): result is MountInactive {
	return 'inactive' in result;
}

/**
 * One app mount: a name and an `open(ctx)` that returns a daemon runtime or
 * `inactive(reason)`.
 *
 * Factories like `fuji()` return a `Mount`. The canonical mount name lives on
 * the value itself (`Mount.name`), so renaming an Epicenter folder never
 * changes the action namespace.
 */
export type Mount = {
	name: string;
	open(ctx: MountContext): MaybePromise<DaemonRuntime | MountInactive>;
};

/**
 * Identity helper that pins a mount so factories preserve their shape and
 * `epicenter.config.ts` gets IntelliSense on the context fields. Pure at the
 * value level.
 */
export function defineMount(mount: Mount): Mount {
	return mount;
}

/**
 * Define a mount that needs a signed-in session. The body receives a
 * `SessionMountContext` with a guaranteed-non-null `session`; when machine auth
 * is signed out the daemon reports `inactive("Sign in to enable <name>.")`
 * without ever running the body.
 *
 * Local-only mirrors that can run signed out use `defineMount` instead and read
 * `ctx.session` themselves.
 */
export function defineSessionMount(mount: {
	name: string;
	open(ctx: SessionMountContext): MaybePromise<DaemonRuntime>;
}): Mount {
	return {
		name: mount.name,
		open: (ctx) =>
			ctx.session === null
				? inactive(`Sign in to enable ${ctx.mount}.`)
				: mount.open({ ...ctx, session: ctx.session }),
	};
}
