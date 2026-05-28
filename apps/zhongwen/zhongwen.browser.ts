/**
 * Zhongwen browser composition.
 *
 * Single source of truth for "how Zhongwen mounts in a browser." Calls Tier 1
 * primitives inline so every line is visible top-to-bottom:
 *
 *  1. workspace root doc (encrypted tables + KV via createZhongwenWorkspace)
 *  2. local storage + cloud sync for root (attachLocalStorage + openCollaboration)
 *
 * Zhongwen has no child docs and no daemon actions; the root doc is the
 * entire workspace surface. `openCollaboration` owns reconnect-on-auth-change
 * internally, so this file has no per-app onStateChange listener. The
 * bundle's `wipe()` drops every encrypted IDB database for this owner;
 * `Symbol.dispose` tears down the root Y.Doc without touching local storage.
 */

import type { SignedIn } from '@epicenter/svelte';
import {
	attachLocalStorage,
	type DeviceId,
	defineWorkspace,
	openCollaboration,
	roomWsUrl,
	wipeLocalStorage,
} from '@epicenter/workspace';
import { createZhongwenWorkspace } from './zhongwen';

export function openZhongwenBrowser({
	signedIn,
	deviceId,
}: {
	signedIn: SignedIn;
	deviceId: DeviceId;
}) {
	const workspace = createZhongwenWorkspace({ keyring: signedIn.keyring });

	const idb = attachLocalStorage(workspace.ydoc, {
		server: signedIn.server,
		ownerId: signedIn.ownerId,
		keyring: signedIn.keyring,
	});
	const collaboration = openCollaboration(workspace.ydoc, {
		url: roomWsUrl({
			baseURL: signedIn.baseURL,
			ownerId: signedIn.ownerId,
			guid: workspace.ydoc.guid,
			deviceId,
		}),
		openWebSocket: signedIn.openWebSocket,
		onReconnectSignal: signedIn.onReconnectSignal,
		waitFor: idb.whenLoaded,
		actions: workspace.actions,
	});

	return defineWorkspace({
		...workspace,
		idb,
		collaboration,
		async wipe() {
			workspace[Symbol.dispose]();
			await Promise.all([idb.whenDisposed, collaboration.whenDisposed]);
			await wipeLocalStorage({
				server: signedIn.server,
				ownerId: signedIn.ownerId,
			});
		},
	});
}

export type ZhongwenBrowser = ReturnType<typeof openZhongwenBrowser>;
