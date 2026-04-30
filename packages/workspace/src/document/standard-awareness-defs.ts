/**
 * Standard awareness convention for cross-device peer presence.
 *
 * Each connected peer publishes a small `device` descriptor (id, name,
 * platform). Other peers read awareness to enumerate who's online and
 * dispatch via `peer<T>(workspace, deviceId)`.
 *
 * Action discovery is NOT in awareness: it's an on-demand RPC. Use
 * `describePeer(sync, deviceId)` to fetch a peer's full action
 * tree when you need it.
 *
 * Apps opt in by spreading `standardAwarenessDefs` into their `attachAwareness`
 * call; app-specific fields can be added alongside:
 *
 * ```ts
 * const awareness = attachAwareness(ydoc, {
 *   ...standardAwarenessDefs,
 *   cursor: type({ x: 'number', y: 'number' }),  // app-specific field
 * });
 * awareness.setLocal({
 *   device: {
 *     id: getOrCreateDeviceId(localStorage),
 *     name: 'Braden MacBook',
 *     platform: 'web',
 *   },
 * });
 * ```
 */

import { type } from 'arktype';

/** Closed enum of supported platforms: extends as new app targets ship. */
export const Platform = type(
	'"web" | "tauri" | "chrome-extension" | "node"',
);
export type Platform = typeof Platform.infer;

/**
 * The peer descriptor published by each connected peer. Presence-only
 * carries identity, not capabilities. Action discovery happens on demand
 * via `describePeer(sync, deviceId)`.
 *
 * Named `PeerDevice` (not `Device`) so it doesn't collide with app-level
 * `Device` table-row types (e.g. tab-manager's devices table).
 */
export const PeerDevice = type({
	id: 'string',
	name: 'string',
	platform: Platform,
});
export type PeerDevice = typeof PeerDevice.infer;

/**
 * Input shape for workspace factories. Identical to `PeerDevice`: kept as
 * a separate alias so apps with branded ID types (e.g. tab-manager's
 * `DeviceId`) can carry the brand through the factory without `as` casts.
 * Defaults to `string`: SPAs and untyped consumers see no difference.
 */
export type DeviceDescriptor<TId extends string = string> = {
	id: TId;
	name: string;
	platform: Platform;
};

/**
 * Spread into `attachAwareness` defs to enable typed access to the
 * `state.device` field on peer awareness states.
 */
export const standardAwarenessDefs = {
	device: PeerDevice,
};

/** A peer's awareness state under the standard `device` schema. */
export type PeerAwarenessState = { device: PeerDevice };

/** Result of a `find(deviceId)` lookup: clientId plus full peer state. */
export type FoundPeer = { clientId: number; state: PeerAwarenessState };
