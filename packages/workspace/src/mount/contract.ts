/**
 * The mount contract: everything that defines what a mount IS and how to tell a
 * valid one from an invalid one, in a single drift-proof place.
 *
 * `epicenter.config.ts` default-exports one `Mount`. The mount carries its own
 * canonical `name`, which becomes the CLI action prefix (`<name>.<action_key>`)
 * and is propagated into `MountContext` so handlers can share it with logs,
 * materializers, and client ids. The host calls `open(ctx)` once on
 * `epicenter daemon up`; the returned `DaemonRuntime` is what the socket app
 * serves.
 *
 * The runtime guard (`isMount`) and the name-format rule (`isValidMountName`)
 * live here next to the type they validate, so a change to `Mount` cannot drift
 * from the code that checks it. This module is browser-safe: types plus pure
 * functions, no `node:*`.
 */

import type { Keyring } from '@epicenter/encryption';
import type { OwnerId } from '@epicenter/identity';
import type { DeviceId } from '../document/device-id.js';
import type {
	Collaboration,
	OnReconnectSignal,
	OpenWebSocketFn,
} from '../document/open-collaboration.js';
import type { ActionRegistry } from '../shared/actions.js';
import type {
	AuthedFetch,
	EpicenterRoot,
	MaybePromise,
} from '../shared/types.js';

/**
 * Fields the daemon looks at on each started runtime: async dispose plus the
 * hosted `Collaboration<TActions>` that owns identity, actions, sync, and the
 * live-device surface.
 */
export type DaemonRuntime<TActions extends ActionRegistry = ActionRegistry> = {
	/** Called by the daemon at exit. */
	[Symbol.asyncDispose](): MaybePromise<void>;

	/**
	 * The hosted collaboration. Identity, action registry, sync status, and the
	 * live-device surface for cross-mount dispatch all live here.
	 */
	readonly collaboration: Collaboration<TActions>;
};

/** One configured mount runtime hosted by the daemon. */
export type StartedMount = {
	mount: string;
	runtime: DaemonRuntime;
};

/**
 * Context handed to `open()` for one mount.
 *
 * The host owns auth: it refuses to call `open` when machine auth is
 * signed-out, exposes the keyring lookup (with a late-sign-out guard baked
 * into the closure), and passes the auth-derived function refs through for
 * cloud sync.
 *
 * - `epicenterRoot` is the resolved Epicenter root (the folder that holds
 *   `epicenter.config.ts`). Disk-writing helpers like `yjsPath` derive every
 *   absolute path from it.
 * - `mount` is the canonical mount name (`Mount.name`). Pinned here so
 *   handlers can share the same identifier with logs, materializers, and
 *   client ids.
 * - `yDocClientId` is the deterministic Y.Doc CRDT `clientID` for this
 *   daemon (derived from `epicenterRoot`). Pin it on the Y.Doc with
 *   `ydoc.clientID = ctx.yDocClientId` right after construction.
 * - `deviceId` is the conventional collaboration WebSocket device id for
 *   the daemon side of this mount (`<mount>-daemon`).
 * - `ownerId` is the workspace owner id snapshotted at startup. Stable for
 *   the lifetime of the daemon process.
 * - `keyring` is the lazy reader for the current owner keyring. The host's
 *   closure throws on late sign-out so writes fail loud instead of silently
 *   losing ciphertext.
 * - `openWebSocket` opens the relay socket for `openCollaboration`.
 * - `onReconnectSignal` subscribes to auth-state transitions that trigger
 *   sync reconnect.
 * - `fetch` is the auth-owned `fetch` (owner bearer attached, 401-refresh
 *   handled) for one-shot HTTP to the relay.
 */
export type MountContext = {
	epicenterRoot: EpicenterRoot;
	mount: string;
	yDocClientId: number;
	deviceId: DeviceId;
	ownerId: OwnerId;
	keyring: () => Keyring;
	openWebSocket: OpenWebSocketFn;
	onReconnectSignal: OnReconnectSignal;
	fetch: AuthedFetch;
};

/**
 * One app mount: a name plus an `open(ctx)` that returns a `DaemonRuntime`.
 *
 * Factories like `fuji()` return a `Mount`. The canonical mount name lives on
 * the value itself (`Mount.name`), so renaming a project folder never changes
 * the action namespace.
 */
export type Mount<TRuntime extends DaemonRuntime = DaemonRuntime> = {
	name: string;
	open(ctx: MountContext): MaybePromise<TRuntime>;
};

/**
 * Identity helper that pins `Mount<TRuntime>` so factories preserve their
 * runtime shape and `epicenter.config.ts` gets IntelliSense on the context
 * fields. Pure at the value level.
 */
export function defineMount<TRuntime extends DaemonRuntime>(
	mount: Mount<TRuntime>,
): Mount<TRuntime> {
	return mount;
}

/**
 * Runtime witness for `Mount`. `epicenter.config.ts` is dynamically imported,
 * so its default export crosses a boundary where TypeScript types are erased;
 * `isMount` asserts the exact two members the daemon consumes (`name: string`,
 * `open: function`). It lives next to `Mount` so the guard and the type cannot
 * drift apart.
 */
export function isMount(value: unknown): value is Mount {
	return (
		typeof value === 'object' &&
		value !== null &&
		'name' in value &&
		typeof (value as { name: unknown }).name === 'string' &&
		'open' in value &&
		typeof (value as { open: unknown }).open === 'function'
	);
}

// Mount names are config-supplied identifiers (or carried by the Mount itself).
// They become the prefix of `/list` manifest keys and daemon action paths
// (`${mount}.${action}`), so they must exclude `.` (the mount boundary) and
// start with an alphanumeric. The leading-character class also rejects
// `__proto__` and other underscore-led names.
const MOUNT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/**
 * The single home for the mount-name format rule. The loader checks it per
 * config (the earliest point, with a file-pointed error); `validateMountNames`
 * reuses it when validating the daemon's whole served set.
 */
export function isValidMountName(name: string): boolean {
	return MOUNT_NAME_PATTERN.test(name);
}

export type MountNameIssue = {
	mount: string;
	reason: 'invalid' | 'duplicate';
};

/**
 * Validate the daemon's served set: every name well-formed, no two the same.
 * Duplicate detection is the part that can only happen here, once the set is
 * assembled (one config can never collide with itself).
 */
export function validateMountNames(
	mounts: readonly string[],
): MountNameIssue | null {
	const seen = new Set<string>();
	for (const mount of mounts) {
		if (seen.has(mount)) return { mount, reason: 'duplicate' };
		seen.add(mount);
	}
	for (const mount of mounts) {
		if (!isValidMountName(mount)) {
			return { mount, reason: 'invalid' };
		}
	}
	return null;
}
