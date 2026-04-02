/**
 * Honeycrisp workspace client — single Y.Doc instance with IndexedDB
 * persistence, encryption, and WebSocket sync.
 *
 * Access tables via `workspace.tables.folders` / `workspace.tables.notes`
 * and KV settings via `workspace.kv`. The client is ready when
 * `workspace.whenReady` resolves.
 */

import { APP_URLS } from '@epicenter/constants/vite';
import { createAuth } from '@epicenter/svelte/auth';
import { createWorkspace } from '@epicenter/workspace';
import { createSyncExtension, toWsUrl } from '@epicenter/workspace/extensions/sync/websocket';
import { indexeddbPersistence } from '@epicenter/workspace/extensions/persistence/indexeddb';
import { session } from '$lib/auth';
import { createIndexedDbKeyStore } from '@epicenter/svelte-utils';
import { honeycrisp } from './workspace/definition';


export const workspace = createWorkspace(honeycrisp)
	.withEncryption({ userKeyStore: createIndexedDbKeyStore('honeycrisp:encryption-key') })
	.withExtension('persistence', indexeddbPersistence)
	.withExtension(
		'sync',
		createSyncExtension({
			url: (workspaceId) => toWsUrl(`${APP_URLS.API}/workspaces/${workspaceId}`),
			getToken: async () => auth.token,
		}),
	);

export const auth = createAuth({
	baseURL: APP_URLS.API,
	session,
	onLogin(session) {
		workspace.unlockWithKeys(session.encryptionKeys);
		workspace.extensions.sync.reconnect();
	},
	onLogout() {
		workspace.clearLocalData();
		workspace.extensions.sync.reconnect();
	},
});

