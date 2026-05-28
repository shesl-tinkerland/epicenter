/**
 * Opensidian browser composition.
 *
 * Single source of truth for "how Opensidian mounts in a browser." Calls
 * Tier 1 primitives inline so every line is visible top-to-bottom:
 *
 *  1. workspace root doc (encrypted tables + KV via createOpensidianWorkspace)
 *  2. local storage + cloud sync for root (attachLocalStorage + openCollaboration)
 *  3. runtime storage + sync around the shared per-file child docs
 *  4. file system, sqlite index, bash, and action registry
 *  5. wipe / dispose teardown
 *
 * `openCollaboration` owns reconnect-on-auth-change internally, so this file
 * has no per-app onStateChange listener.
 *
 * The bundle's `wipe()` drops every encrypted IDB database for this owner;
 * `Symbol.dispose` tears down the root + cached child Y.Docs without touching
 * local storage.
 */

import {
	attachYjsFileSystem,
	createSqliteIndex,
	type FileId,
} from '@epicenter/filesystem';
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
import { Bash } from 'just-bash';
import { createOpensidianWorkspace } from './opensidian';
import { createOpensidianActions } from './opensidian.browser.actions';

export function openOpensidianBrowser({
	signedIn,
	deviceId,
}: {
	signedIn: SignedIn;
	deviceId: DeviceId;
}) {
	const workspace = createOpensidianWorkspace({ keyring: signedIn.keyring });
	const { ydoc, tables } = workspace;

	const idb = attachLocalStorage(ydoc, {
		server: signedIn.server,
		ownerId: signedIn.ownerId,
		keyring: signedIn.keyring,
	});

	const fileContentDocs = createDisposableCache((fileId: FileId) => {
		const contentDoc = workspace.fileContentDocs.open(fileId);
		const childIdb = attachLocalStorage(contentDoc.ydoc, {
			server: signedIn.server,
			ownerId: signedIn.ownerId,
			keyring: signedIn.keyring,
		});
		// File bodies sync through Cloud so device loss doesn't drop the largest
		// data class.
		const childSync = openCollaboration(contentDoc.ydoc, {
			url: roomWsUrl({
				baseURL: signedIn.baseURL,
				ownerId: signedIn.ownerId,
				guid: contentDoc.ydoc.guid,
				deviceId,
			}),
			openWebSocket: signedIn.openWebSocket,
			onReconnectSignal: signedIn.onReconnectSignal,
			waitFor: childIdb.whenLoaded,
			actions: {},
		});
		return {
			...contentDoc,
			idb: childIdb,
			sync: childSync,
			/**
			 * Child disposer rejections do not propagate; bundle.wipe() relies on
			 * IDB's deleteDatabase native blocking as belt-and-suspenders for
			 * storage deletion.
			 */
			[Symbol.dispose]() {
				contentDoc[Symbol.dispose]();
			},
		};
	});
	const fileContent = {
		async read(fileId: FileId) {
			await using handle = fileContentDocs.open(fileId);
			await handle.idb.whenLoaded;
			return handle.content.read();
		},
		async write(fileId: FileId, text: string) {
			await using handle = fileContentDocs.open(fileId);
			await handle.idb.whenLoaded;
			handle.content.write(text);
		},
		async append(fileId: FileId, text: string) {
			await using handle = fileContentDocs.open(fileId);
			await handle.idb.whenLoaded;
			handle.content.appendText(text);
			return handle.content.read();
		},
	};
	const sqliteIndex = createSqliteIndex({
		readContent: fileContent.read,
	})({
		tables,
	});
	const sqliteIndexExports = sqliteIndex.exports;
	const fs = attachYjsFileSystem(ydoc, tables.files, fileContent);
	const bash = new Bash({ fs, cwd: '/' });
	const actions = {
		...workspace.actions,
		...createOpensidianActions({
			fs,
			sqliteIndex: sqliteIndexExports,
			bash,
		}),
	};

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

	let docsTornDown = false;

	function teardownDocs() {
		if (docsTornDown) return;
		docsTornDown = true;
		fileContentDocs[Symbol.dispose]();
		sqliteIndex[Symbol.dispose]();
		workspace[Symbol.dispose]();
	}

	return defineWorkspace({
		...workspace,
		idb,
		fileContentDocs,
		sqliteIndex: sqliteIndexExports,
		fs,
		bash,
		actions,
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

export type OpensidianBrowser = ReturnType<typeof openOpensidianBrowser>;
