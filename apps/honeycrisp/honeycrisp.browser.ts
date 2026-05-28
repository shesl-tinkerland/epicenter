/**
 * Honeycrisp browser composition.
 *
 * Single source of truth for "how Honeycrisp mounts in a browser." Calls
 * Tier 1 primitives inline so every line is visible top-to-bottom:
 *
 *  1. workspace root doc (encrypted tables + KV via createHoneycrispWorkspace)
 *  2. local storage + cloud sync for root (attachLocalStorage + openCollaboration)
 *  3. runtime storage + sync around the shared per-note child docs
 *
 * `openCollaboration` owns reconnect-on-auth-change internally, so this file
 * has no per-app onStateChange listener.
 *
 * The bundle's `wipe()` drops every encrypted IDB database for this owner;
 * `Symbol.dispose` tears down the root + cached child Y.Docs without touching
 * local storage.
 */

import type { SignedIn } from '@epicenter/svelte';
import {
	attachLocalStorage,
	createDisposableCache,
	type DeviceId,
	defineWorkspace,
	openCollaboration,
	roomWsUrl,
	wipeLocalStorage,
} from '@epicenter/workspace';
import { createHoneycrispWorkspace, type NoteId } from './honeycrisp';

export function openHoneycrispBrowser({
	signedIn,
	deviceId,
}: {
	signedIn: SignedIn;
	deviceId: DeviceId;
}) {
	const workspace = createHoneycrispWorkspace({ keyring: signedIn.keyring });

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

	const noteBodyDocs = createDisposableCache((noteId: NoteId) => {
		const bodyDoc = workspace.noteBodyDocs.open(noteId);
		const childIdb = attachLocalStorage(bodyDoc.ydoc, {
			server: signedIn.server,
			ownerId: signedIn.ownerId,
			keyring: signedIn.keyring,
		});
		const childSync = openCollaboration(bodyDoc.ydoc, {
			url: roomWsUrl({
				baseURL: signedIn.baseURL,
				ownerId: signedIn.ownerId,
				guid: bodyDoc.ydoc.guid,
				deviceId,
			}),
			openWebSocket: signedIn.openWebSocket,
			onReconnectSignal: signedIn.onReconnectSignal,
			waitFor: childIdb.whenLoaded,
			actions: {},
		});

		return {
			...bodyDoc,
			idb: childIdb,
			sync: childSync,
			/**
			 * Child disposer rejections do not propagate; bundle.wipe() relies on
			 * IDB's deleteDatabase native blocking as belt-and-suspenders for
			 * storage deletion.
			 */
			[Symbol.dispose]() {
				bodyDoc[Symbol.dispose]();
			},
		};
	});

	return defineWorkspace({
		...workspace,
		actions: workspace.actions,
		idb,
		noteBodyDocs,
		collaboration,
		async wipe() {
			noteBodyDocs[Symbol.dispose]();
			workspace[Symbol.dispose]();
			await Promise.all([idb.whenDisposed, collaboration.whenDisposed]);
			await wipeLocalStorage({
				server: signedIn.server,
				ownerId: signedIn.ownerId,
			});
		},
		[Symbol.dispose]() {
			noteBodyDocs[Symbol.dispose]();
			workspace[Symbol.dispose]();
		},
	});
}

export type HoneycrispBrowser = ReturnType<typeof openHoneycrispBrowser>;
