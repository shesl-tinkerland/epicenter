import type { SyncAuthClient } from '@epicenter/auth';
import { EPICENTER_TAB_MANAGER_OAUTH_CLIENT_ID } from '@epicenter/constants/oauth-clients';
import { APP_URLS } from '@epicenter/constants/vite';
import { createOAuthAppAuth, createSession } from '@epicenter/svelte/auth';
import { openCollaboration, roomWsUrl } from '@epicenter/workspace';
import { actionsToAiTools } from '@epicenter/workspace/ai';
import { createAiChatState } from './chat/chat-state.svelte';
import { createDeviceProfile, registerDevice } from './device';
import {
	oauthLauncher,
	persistedAuthStoragePromise,
} from './platform/auth/auth';
import { createBookmarkState } from './state/bookmark-state.svelte';
import { createSavedTabState } from './state/saved-tab-state.svelte';
import { createToolTrustState } from './state/tool-trust.svelte';
import { createUnifiedViewState } from './state/unified-view-state.svelte';
import {
	openTabManagerBrowser,
	type TabManagerBrowser,
} from './tab-manager/extension';

export type SessionAiTools = ReturnType<
	typeof actionsToAiTools<TabManagerBrowser['actions']>
>;
export type SessionTools = SessionAiTools['tools'];

/**
 * Deferred-init values: set exactly once when `persistedAuthStoragePromise`
 * AND the peer identity have resolved. They are plain `let`, not `$state`,
 * because nothing needs the assignment itself to drive reactivity; consumers
 * await `tabManagerSession.whenReady` before reading.
 *
 * Once storage and peer are ready, `session` is the synchronous
 * `createSession()` return value. Its `current` getter is `null` when signed
 * out and the augmented tab-manager binding (binding fields + `state` +
 * `sessionAiTools`) when signed in.
 */
let authClient: SyncAuthClient | undefined;
let session: ReturnType<typeof buildSession> | undefined;

const whenReady = Promise.all([
	persistedAuthStoragePromise,
	createDeviceProfile(),
]).then(([persistedAuthStorage, profile]) => {
	const auth = createOAuthAppAuth({
		baseURL: APP_URLS.API,
		clientId: EPICENTER_TAB_MANAGER_OAUTH_CLIENT_ID,
		persistedAuthStorage,
		launcher: oauthLauncher,
	});
	authClient = auth;
	session = buildSession(auth, profile);
});

function buildSession(
	auth: SyncAuthClient,
	profile: Awaited<ReturnType<typeof createDeviceProfile>>,
) {
	return createSession({
		auth,
		build: (signedIn) => {
			const tabManager = openTabManagerBrowser({
				signedIn,
				nodeId: profile.nodeId,
			});

			const collaboration = openCollaboration(tabManager.ydoc, {
				url: roomWsUrl({
					baseURL: signedIn.baseURL,
					ownerId: signedIn.ownerId,
					guid: tabManager.ydoc.guid,
					nodeId: profile.nodeId,
				}),
				openWebSocket: signedIn.openWebSocket,
				onReconnectSignal: signedIn.onReconnectSignal,
				waitFor: tabManager.idb.whenLoaded,
				actions: tabManager.actions,
			});

			const sessionAiTools = actionsToAiTools(tabManager.actions);
			const savedTabs = createSavedTabState(tabManager);
			const bookmarks = createBookmarkState(tabManager);
			const toolTrust = createToolTrustState(tabManager);
			const unifiedView = createUnifiedViewState({ bookmarks, savedTabs });
			const aiChat = createAiChatState({ auth, tabManager, sessionAiTools });
			const state = { savedTabs, bookmarks, toolTrust, unifiedView, aiChat };

			void tabManager.idb.whenLoaded.then(() =>
				registerDevice(tabManager, profile.defaultName),
			);

			return {
				...tabManager,
				collaboration,
				state,
				sessionAiTools,
				[Symbol.dispose]() {
					aiChat[Symbol.dispose]();
					toolTrust[Symbol.dispose]();
					bookmarks[Symbol.dispose]();
					savedTabs[Symbol.dispose]();
					tabManager[Symbol.dispose]();
				},
			};
		},
	});
}

export const tabManagerSession = {
	get auth(): SyncAuthClient {
		if (!authClient) {
			throw new Error('[tab-manager] auth read before storage readiness.');
		}
		return authClient;
	},
	get current() {
		if (!session) {
			throw new Error(
				'[tab-manager] tabManagerSession.current read before storage readiness.',
			);
		}
		return session.current;
	},
	whenReady,
	[Symbol.dispose]() {
		session?.[Symbol.dispose]();
		authClient?.[Symbol.dispose]();
	},
};

if (import.meta.hot) {
	import.meta.hot.dispose(() => tabManagerSession[Symbol.dispose]());
}

export function requireTabManager() {
	if (!session) {
		throw new Error(
			'[tab-manager] requireTabManager() called before storage readiness. ' +
				'Components must mount under `{#await tabManagerSession.whenReady}`.',
		);
	}
	return session.require();
}
