/**
 * Owner-scoped synced construction for Whispering.
 *
 * Two pure-ish building blocks the boot selector (`openActiveWhispering`)
 * composes when signed in:
 *
 *  - `buildSignedIn(auth)` projects the current auth state into the `SignedIn`
 *    payload every workspace opener consumes. This is the ~12 lines that
 *    `createSession` would otherwise package; we inline it on purpose, because
 *    `createSession`'s live reactive swap fights reload-on-auth (see the spec's
 *    decision 2.3).
 *  - `wireSynced(ydoc, ...)` attaches encrypted owner-partitioned local storage
 *    and opens relay sync. It mirrors fuji's `wire()`; Whispering has no child
 *    docs, so this is the only call.
 */

import type { SyncAuthClient } from '@epicenter/auth';
import type { SignedIn } from '@epicenter/svelte';
import {
	type ActionRegistry,
	attachLocalStorage,
	type DeviceId,
	openCollaboration,
	roomWsUrl,
} from '@epicenter/workspace';
import type * as Y from 'yjs';

/**
 * Project the current (non-signed-out) `auth.state` into a `SignedIn` payload.
 *
 * `server`/`baseURL` are constant across auth states (one API per client), so
 * they are read once. `keyring` is a callback that re-reads the live state so a
 * refreshed keyring (reauth-required to signed-in) is picked up without
 * rebuilding the doc. Throws if called while signed-out: callers branch on
 * `auth.state.status` first.
 */
export function buildSignedIn(auth: SyncAuthClient): SignedIn {
	const baseURL = auth.baseURL;
	const server = new URL(baseURL).host;
	const state = auth.state;
	if (state.status === 'signed-out') {
		throw new Error('[whispering] buildSignedIn() called while signed-out.');
	}
	return {
		server,
		baseURL,
		ownerId: state.ownerId,
		keyring: () => {
			const live = auth.state;
			if (live.status === 'signed-out') {
				throw new Error('[whispering] keyring() called while signed-out.');
			}
			return live.keyring;
		},
		openWebSocket: auth.openWebSocket,
		onReconnectSignal: auth.onStateChange,
	};
}

/**
 * Attach the encrypted, owner-partitioned local store plus relay sync to one
 * doc: `attachLocalStorage` for at-rest encryption and `openCollaboration` for
 * cross-device sync that waits for local replay before connecting. Mirrors
 * fuji's `wire()`.
 */
export function wireSynced(
	ydoc: Y.Doc,
	{
		signedIn,
		deviceId,
		actions,
	}: { signedIn: SignedIn; deviceId: DeviceId; actions: ActionRegistry },
) {
	const idb = attachLocalStorage(ydoc, {
		server: signedIn.server,
		ownerId: signedIn.ownerId,
		keyring: signedIn.keyring,
	});
	const collaboration = openCollaboration(ydoc, {
		url: roomWsUrl({
			baseURL: signedIn.baseURL,
			ownerId: signedIn.ownerId,
			guid: ydoc.guid,
			deviceId,
		}),
		openWebSocket: signedIn.openWebSocket,
		onReconnectSignal: signedIn.onReconnectSignal,
		waitFor: idb.whenLoaded,
		actions,
	});
	return { idb, collaboration };
}
