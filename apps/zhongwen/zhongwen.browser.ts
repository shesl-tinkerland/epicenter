/**
 * Zhongwen browser composition.
 *
 * Single source of truth for "how Zhongwen mounts in a browser." Calls Tier 1
 * primitives inline so every line is visible top-to-bottom:
 *
 *  1. workspace root doc (encrypted tables + KV via createZhongwen)
 *  2. local storage + cloud sync for root (attachLocalStorage + openCollaboration)
 *  3. runtime storage + sync around the per-conversation transcript child docs
 *
 * `openCollaboration` owns reconnect-on-auth-change internally, so this file
 * has no per-app onStateChange listener. The bundle's `wipe()` drops every
 * encrypted IDB database for this owner; `Symbol.dispose` tears down the root
 * + cached child Y.Docs without touching local storage.
 */

import type { SignedIn } from '@epicenter/svelte/auth';
import {
	attachLocalStorage,
	createDisposableCache,
	type DeviceId,
	defineWorkspace,
	openCollaboration,
	roomWsUrl,
	wipeLocalStorage,
} from '@epicenter/workspace';
import * as Y from 'yjs';
import {
	type ConversationId,
	createZhongwen,
	zhongwenConversationDocGuid,
} from './zhongwen';

/**
 * Open Zhongwen in the browser with encrypted local storage, cloud sync, and
 * the per-conversation transcript doc cache.
 */
export function openZhongwenBrowser({
	signedIn,
	deviceId,
}: {
	signedIn: SignedIn;
	deviceId: DeviceId;
}) {
	const workspace = createZhongwen({ keyring: signedIn.keyring });

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

	const conversationDocs = createDisposableCache(
		(conversationId: ConversationId) => {
			const ydoc = new Y.Doc({
				guid: zhongwenConversationDocGuid(conversationId),
				gc: true,
			});
			const childIdb = attachLocalStorage(ydoc, {
				server: signedIn.server,
				ownerId: signedIn.ownerId,
				keyring: signedIn.keyring,
			});
			// Transcripts sync through Cloud: that is what lets the server
			// generation actor stream assistant tokens into the doc and lets
			// every signed-in device watch them live.
			const childSync = openCollaboration(ydoc, {
				url: roomWsUrl({
					baseURL: signedIn.baseURL,
					ownerId: signedIn.ownerId,
					guid: ydoc.guid,
					deviceId,
				}),
				openWebSocket: signedIn.openWebSocket,
				onReconnectSignal: signedIn.onReconnectSignal,
				waitFor: childIdb.whenLoaded,
				actions: {},
			});
			return {
				ydoc,
				idb: childIdb,
				sync: childSync,
				/**
				 * Child disposer rejections do not propagate; bundle.wipe() relies on
				 * IDB's deleteDatabase native blocking as belt-and-suspenders for
				 * storage deletion.
				 */
				[Symbol.dispose]() {
					ydoc.destroy();
				},
			};
		},
	);

	let docsTornDown = false;

	function teardownDocs() {
		if (docsTornDown) return;
		docsTornDown = true;
		conversationDocs[Symbol.dispose]();
		workspace[Symbol.dispose]();
	}

	return defineWorkspace({
		...workspace,
		idb,
		conversationDocs,
		collaboration,
		async wipe() {
			teardownDocs();
			await Promise.all([idb.whenDisposed, collaboration.whenDisposed]);
			await wipeLocalStorage({
				server: signedIn.server,
				ownerId: signedIn.ownerId,
			});
		},
		[Symbol.dispose]() {
			teardownDocs();
		},
	});
}
