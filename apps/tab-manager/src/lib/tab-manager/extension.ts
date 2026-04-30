/**
 * Live browser state (tabs, windows, tab groups) is NOT stored here —
 * Chrome is the sole authority for ephemeral browser state. See
 * `browser-state.svelte.ts`.
 */

import type { AuthClient } from '@epicenter/auth-svelte';
import { APP_URLS } from '@epicenter/constants/vite';
import {
	attachBroadcastChannel,
	attachIndexedDb,
	attachSync,
	type DeviceDescriptor,
	toWsUrl,
} from '@epicenter/workspace';
import type { DeviceId } from '$lib/workspace/definition';
import { openTabManager as openTabManagerDoc } from './index';

/**
 * Construction is async because awareness publishes the device descriptor
 * synchronously at attach time (no two-step "online but no device yet"
 * window). Awaiting the descriptor up front means every peer sees a
 * well-formed `state.device` from the first frame.
 *
 * `whenReady` still gates UI render on idb hydration; sync (the WebSocket)
 * is independent and connects whenever the network allows.
 */
export async function openTabManager({
	auth,
	device,
}: {
	auth: AuthClient;
	device: DeviceDescriptor<DeviceId> | Promise<DeviceDescriptor<DeviceId>>;
}) {
	const resolvedDevice = await Promise.resolve(device);

	const doc = openTabManagerDoc({ deviceId: Promise.resolve(resolvedDevice.id) });

	const idb = attachIndexedDb(doc.ydoc);
	attachBroadcastChannel(doc.ydoc);

	const sync = attachSync(doc, {
		url: toWsUrl(`${APP_URLS.API}/workspaces/${doc.ydoc.guid}`),
		waitFor: idb,
		device: resolvedDevice,
		getToken: async () => auth.getToken(),
	});

	return {
		...doc,
		idb,
		sync,
		/**
		 * Resolves when IndexedDB has hydrated the local snapshot — the UI
		 * can render with persisted data. Does NOT gate sync (the WebSocket
		 * can connect at any time, including never if the extension is offline).
		 */
		whenReady: idb.whenLoaded,
		device: resolvedDevice,
	};
}
