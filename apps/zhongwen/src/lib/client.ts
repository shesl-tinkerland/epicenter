/**
 * Workspace client — browser-specific wiring.
 *
 * IndexedDB persistence + BroadcastChannel sync with cached startup unlock.
 */

import { APP_URLS } from '@epicenter/constants/vite';
import { createAuth } from '@epicenter/svelte/auth';
import { createWorkspace } from '@epicenter/workspace';
import { broadcastChannelSync } from '@epicenter/workspace/extensions/sync/broadcast-channel';
import { indexeddbPersistence } from '@epicenter/workspace/extensions/persistence/indexeddb';
import { session } from '$lib/auth';
import { definition } from './workspace/definition';
import { createIndexedDbKeyStore } from '@epicenter/svelte-utils';
export const workspace = createWorkspace(definition)
	.withEncryption({ userKeyStore: createIndexedDbKeyStore('zhongwen:encryption-key') })
	.withExtension('persistence', indexeddbPersistence)
	.withExtension('broadcast', broadcastChannelSync);

export const auth = createAuth({
	baseURL: APP_URLS.API,
	session,
	onLogin(session) {
		workspace.unlockWithKeys(session.encryptionKeys);
	},
	onLogout() {
		workspace.clearLocalData();
	},
});
