/**
 * `defineMount`: typed entry contract for an app mount inside a project daemon.
 *
 * `epicenter.config.ts` default-exports a `Mount` (single mount) or a
 * `Mount[]` (multi-mount). Each mount carries its own canonical `name`, which
 * becomes the CLI action prefix (`<name>.<action_key>`) and is propagated into
 * `MountContext` so handlers can use it for logging.
 *
 * The host calls `open(ctx)` once on `epicenter daemon up`. The returned
 * runtime shape matches `DaemonRuntime` so the socket app does not branch on
 * mount origin.
 */

import type { OwnerId } from '@epicenter/constants/identity';
import type { Keyring } from '@epicenter/encryption';
import type { DeviceId } from '../document/device-id.js';
import type {
	OnReconnectSignal,
	OpenWebSocketFn,
} from '../document/open-collaboration.js';
import type { MaybePromise, ProjectDir } from '../shared/types.js';
import type { DaemonRuntime } from './types.js';

/**
 * Context handed to `open()` for one mount.
 *
 * The host owns auth: it refuses to call `open` when machine auth is
 * signed-out, exposes the keyring lookup (with a late-sign-out guard baked
 * into the closure), and passes the auth-derived function refs through for
 * cloud sync.
 *
 * - `projectDir` is the resolved project root. Disk-writing helpers like
 *   `yjsPath` derive every absolute path from it.
 * - `mount` is the canonical mount name (`Mount.name`). Pinned here so
 *   handlers can share the same identifier with logs, materializers, and
 *   client ids.
 * - `yDocClientId` is the deterministic Y.Doc CRDT `clientID` for this
 *   daemon (derived from `projectDir`). Pin it on the Y.Doc with
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
 */
export type MountContext = {
	projectDir: ProjectDir;
	mount: string;
	yDocClientId: number;
	deviceId: DeviceId;
	ownerId: OwnerId;
	keyring: () => Keyring;
	openWebSocket: OpenWebSocketFn;
	onReconnectSignal: OnReconnectSignal;
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
