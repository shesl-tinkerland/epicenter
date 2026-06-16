/**
 * Presence wire protocol: the relay-owned peer list, plus the one frame the
 * node sends to publish its own manifest.
 *
 * The relay owns presence (its `connections` map is the source of truth) and
 * broadcasts the FULL peer list on every membership or manifest change. The
 * client stores the latest list verbatim: there is no delta protocol and no
 * client-side reassembly, the frame IS the state.
 *
 * The wire carries each peer's full action manifest so the receiver can
 * render affordances, validate input schemas, or hand the manifest to an AI
 * tool layer with no second round trip. Manifests are opaque to the relay: it
 * stores and forwards them as bytes, never inspects their shape.
 *
 * Shared by the relay (`packages/server/src/room/core.ts`, the sender) and
 * the client (`open-collaboration.ts`, the reader).
 *
 * Schemas are TypeBox: they ARE valid JSON Schema at runtime, double as the
 * source of truth for the TypeScript types via `Static`, and feed
 * `typebox/compile`'s `Compile()` to produce checked-once validators reused
 * at every boundary. No hand-written duck-typing helpers.
 */

import Type, { type Static } from 'typebox';
import { Compile } from 'typebox/compile';
import { ActionMetaSchema } from '../shared/actions.js';

/**
 * Wire schema for an action manifest. `Record<string, ActionMeta>` where each
 * value is the metadata-only projection of a callable `Action`. Reuses
 * `ActionMetaSchema` so the wire stays in lockstep with the local registry.
 */
export const ActionManifestSchema = Type.Record(
	Type.String(),
	ActionMetaSchema,
);

/**
 * One peer's entry on the wire.
 *
 * `nodeId` routes dispatches; `connectedAt` lets receivers render an
 * "online since" affordance; `actions` is the peer's published manifest, or
 * `{}` if the peer has not (yet) published one.
 */
export const PeerSchema = Type.Object({
	nodeId: Type.String(),
	connectedAt: Type.Number(),
	actions: ActionManifestSchema,
});
export type Peer = Static<typeof PeerSchema>;

/**
 * Server -> client: full set of currently-connected peers, pushed on every
 * membership or manifest change. `peers` always excludes the receiver's
 * own install: the relay computes the list per-recipient so the client never
 * has to filter self.
 */
export const PresenceFrameSchema = Type.Object({
	type: Type.Literal('presence'),
	peers: Type.Array(PeerSchema),
});
export type PresenceFrame = Static<typeof PresenceFrameSchema>;

/**
 * Client -> server: publish this node's action manifest. The relay stores
 * the manifest against the sending socket's nodeId and rebroadcasts
 * presence so peers see the update. Sent once on connect; re-sent if the
 * local action registry changes.
 */
export const PresencePublishFrameSchema = Type.Object({
	type: Type.Literal('presence_publish'),
	actions: ActionManifestSchema,
});
export type PresencePublishFrame = Static<typeof PresencePublishFrameSchema>;

/**
 * Pre-compiled validator for inbound presence frames. Used by the client to
 * narrow untrusted text frames at the receive boundary.
 */
export const checkPresenceFrame = Compile(PresenceFrameSchema);

/**
 * Pre-compiled validator for inbound `presence_publish` frames. Used by the
 * relay to validate peer-supplied manifests before storing.
 */
export const checkPresencePublishFrame = Compile(PresencePublishFrameSchema);
