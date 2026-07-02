import type { SyncAuthClient } from '@epicenter/auth';
import {
	type ActionRegistry,
	attachBroadcastChannel,
	attachIndexedDb,
	type Collaboration,
	connectDoc,
	type NodeId,
} from '@epicenter/workspace';

/**
 * The Y.Doc shape `connectDoc` accepts, derived so this package carries no
 * direct yjs dependency.
 */
type WorkspaceDoc = Parameters<typeof connectDoc>[0];

/**
 * Wire a workspace doc for this boot: the one composition shape every
 * Epicenter workspace app uses (ADR-0088, sign-in is an enhancement, never a
 * door).
 *
 * Reads the persisted `auth.state` ONCE, synchronously, at call time:
 *
 * - signed-out: plain IndexedDB persistence under the doc's own guid, no
 *   relay. `collaboration` is `undefined`.
 * - signed-in / reauth-required: owner-scoped local storage plus relay sync
 *   via `connectDoc`.
 *
 * Identity changes are never an in-place swap: pair this with
 * {@link reloadOnOwnerChange}, which reloads the page so the next boot
 * re-runs this selection. Construction is synchronous; data still loads
 * async behind `whenReady`.
 *
 * The cross-tab BroadcastChannel is attached unconditionally under the doc
 * guid, mirroring the shipped Whispering wiring this was extracted from
 * (signed-in docs additionally get the owner-keyed channel inside
 * `connectDoc`).
 */
export function connectLocalFirst({
	auth,
	ydoc,
	nodeId,
	actions,
}: {
	/** The app's reactive auth client; only its boot snapshot is read here. */
	auth: SyncAuthClient;
	/** The workspace root doc to wire (its `guid` keys storage and the room). */
	ydoc: WorkspaceDoc;
	/** Stable per-node id for relay room addressing (`createNodeId`). */
	nodeId: NodeId;
	/** The root doc's action registry, when it has one. */
	actions?: ActionRegistry;
}): {
	/** Resolves when local persistence has hydrated the doc. */
	whenReady: Promise<unknown>;
	/** Relay sync handle; `undefined` while signed out. */
	collaboration: Collaboration | undefined;
} {
	const state = auth.state;
	attachBroadcastChannel(ydoc);

	if (state.status === 'signed-out') {
		const idb = attachIndexedDb(ydoc);
		return { whenReady: idb.whenLoaded, collaboration: undefined };
	}

	// `server`/`baseURL` are constant across auth states (one API per client).
	// This is the same projection `createSession` does internally; inlined on
	// purpose, because `createSession`'s live reactive swap fights
	// reload-on-auth.
	const baseURL = auth.baseURL;
	const { idb, collaboration } = connectDoc(
		ydoc,
		{
			server: new URL(baseURL).host,
			baseURL,
			ownerId: state.ownerId,
			openWebSocket: auth.openWebSocket,
			onReconnectSignal: auth.onStateChange,
			nodeId,
		},
		{ actions },
	);
	return { whenReady: idb.whenLoaded, collaboration };
}
