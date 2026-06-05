/**
 * Boot-time doc selection for Whispering (Option A: sync singleton + reload).
 *
 * `openActiveWhispering` reads the persisted `auth.state` ONCE at startup and
 * builds either the plaintext local doc (signed out) or the keyring-encrypted
 * owner doc with relay sync (signed in / reauth-required, the keyring is cached
 * in `auth.state`). Construction is synchronous; data still loads async behind
 * `whenReady`.
 *
 * It returns the raw `{ workspace, whenReady, collaboration }` so each platform
 * file can layer its one platform-specific action (`recordings_export_markdown`)
 * on top before exporting the `whispering` singleton. Identity changes are never
 * an in-place swap: `reloadOnOwnerChange` reloads the page so the next boot
 * re-runs this selection.
 */

import { auth } from '#platform/auth';
import {
	attachBroadcastChannel,
	attachIndexedDb,
	createDeviceId,
} from '@epicenter/workspace';
import { createWhispering } from '$lib/workspace';
import { buildSignedIn, wireSynced } from './whispering.synced';

/**
 * Stable per-device id for relay room addressing, read synchronously from
 * `localStorage` (the async variant is only for the extension's
 * `chrome.storage`). Shared across Epicenter apps on this origin.
 */
const deviceId = createDeviceId({ storage: window.localStorage });

export function openActiveWhispering() {
	if (auth.state.status === 'signed-out') {
		const workspace = createWhispering();
		const idb = attachIndexedDb(workspace.ydoc);
		attachBroadcastChannel(workspace.ydoc);
		return { workspace, whenReady: idb.whenLoaded, collaboration: undefined };
	}

	const signedIn = buildSignedIn(auth);
	const workspace = createWhispering({ keyring: signedIn.keyring });
	attachBroadcastChannel(workspace.ydoc);
	const { idb, collaboration } = wireSynced(workspace.ydoc, {
		signedIn,
		deviceId,
		actions: workspace.actions,
	});
	return { workspace, whenReady: idb.whenLoaded, collaboration };
}
