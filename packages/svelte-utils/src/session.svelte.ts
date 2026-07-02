import type { AuthState, SyncAuthClient } from '@epicenter/auth';
import type { OwnerId } from '@epicenter/identity';

/**
 * Auth-gated identity payload that `createSession` hands to the build
 * callback whenever an identity-bearing auth state is present.
 *
 * Flat shape: the auth client is not exposed. Every field is something an
 * app opener actually consumes:
 *
 * - `openCollaboration(workspace.ydoc, { openWebSocket, onReconnectSignal })`
 * - `roomWsUrl({ baseURL, ownerId, guid, nodeId })`
 *
 * `server` and `baseURL` are both projected because `roomWsUrl` wants the
 * full origin (for the ws:// vs wss:// scheme) while local-storage partition
 * names want the host alone.
 *
 * `ownerId` is stable for the lifetime of a single `SignedIn`: a
 * different-owner sign-in produces a new payload via the session's dispose /
 * rebuild cycle.
 *
 * Deployment shape (personal vs shared) is not on this payload; it is a property
 * of the server (see `OwnerId` in `@epicenter/identity`).
 */
export type SignedIn = {
	/**
	 * API origin host (e.g. `api.epicenter.so`). Threads into
	 * `attachLocalStorage` and `wipeLocalStorage` so two self-hosted
	 * instances on the same machine partition local storage separately.
	 */
	server: string;
	/**
	 * Full API origin URL (e.g. `https://api.epicenter.so`). Threads into
	 * `roomWsUrl` so the scheme upgrades to `wss://` cleanly.
	 */
	baseURL: string;
	ownerId: OwnerId;
	/**
	 * Bearer-attached WebSocket opener. Pass to
	 * `openCollaboration({ openWebSocket })`.
	 */
	openWebSocket: SyncAuthClient['openWebSocket'];
	/**
	 * Auth state-change publication. `openCollaboration` subscribes via
	 * `onReconnectSignal` to reconnect after token refreshes; that is the
	 * only current consumer, so the field is named for its purpose at the
	 * sub site rather than for the publisher's verb.
	 */
	onReconnectSignal: SyncAuthClient['onStateChange'];
};

/**
 * Auth-gated payload built once per identity-bearing auth state and disposed
 * on sign-out. `reauth-required` keeps the existing payload mounted: OAuth
 * sessions publish a signed-out gap before a different owner mounts, so two
 * consecutive identity-bearing states are always the same owner.
 *
 * NEVER the owner of a workspace lifecycle (ADR-0088): a workspace app boots
 * its doc with `connectLocalFirst` regardless of auth. This primitive is for
 * auxiliary signed-in-only resources whose whole existence is tied to an
 * identity, e.g. the vault keyring session.
 *
 * The build callback receives a `SignedIn` value with everything an app
 * opener needs: server + baseURL for transport, ownerId for partitioning,
 * and the two auth functions (`openWebSocket`, `onReconnectSignal`) for cloud
 * sync.
 *
 * Requires a `SyncAuthClient` (it threads `auth.openWebSocket` into the payload
 * for cloud sync) whose `state` is Svelte-reactive (use `@epicenter/svelte/auth`,
 * not `@epicenter/auth` directly). A same-origin cookie client is a plain
 * `AuthClient` and cannot be passed here.
 */
export function createSession<T extends Disposable>({
	auth,
	build,
}: {
	auth: SyncAuthClient;
	build: (signedIn: SignedIn) => T;
}) {
	let payload = $state<T | null>(null);
	// `server` and `baseURL` are constant across auth states (the client signs
	// into one API per construction). Compute once; reuse across rebuilds.
	const baseURL = auth.baseURL;
	const server = new URL(baseURL).host;

	function reconcile(state: AuthState) {
		if (state.status === 'signed-out') {
			payload?.[Symbol.dispose]();
			payload = null;
			return;
		}
		if (payload) return;

		buildPayload(state);
	}

	function buildPayload(state: Exclude<AuthState, { status: 'signed-out' }>) {
		payload = build({
			server,
			baseURL,
			ownerId: state.ownerId,
			openWebSocket: auth.openWebSocket,
			onReconnectSignal: auth.onStateChange,
		});
	}

	const unsubscribe = auth.onStateChange(reconcile);
	reconcile(auth.state);

	return {
		get current(): T | null {
			return payload;
		},
		require(): T {
			if (!payload) {
				throw new Error('[session] require() called while signed-out.');
			}
			return payload;
		},
		[Symbol.dispose]() {
			unsubscribe();
			payload?.[Symbol.dispose]();
			payload = null;
		},
	};
}
