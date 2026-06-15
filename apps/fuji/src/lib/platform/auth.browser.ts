import { createWebStoragePersistedAuthStorage } from '@epicenter/auth';
import { createBrowserOAuthLauncher } from '@epicenter/auth/oauth-launchers';
import { EPICENTER_FUJI_OAUTH_CLIENT_ID } from '@epicenter/constants/oauth-clients';
import { APP_URLS } from '@epicenter/constants/vite';
import { createOAuthAppAuth } from '@epicenter/svelte/auth';
import type { PlatformAuth } from './types';

export const auth: PlatformAuth = createOAuthAppAuth({
	baseURL: APP_URLS.API,
	clientId: EPICENTER_FUJI_OAUTH_CLIENT_ID,
	persistedAuthStorage: createWebStoragePersistedAuthStorage({
		key: 'fuji.auth.persisted',
		storage: window.localStorage,
	}),
	launcher: createBrowserOAuthLauncher({
		issuer: `${APP_URLS.API}/auth`,
		clientId: EPICENTER_FUJI_OAUTH_CLIENT_ID,
		resource: APP_URLS.API,
		redirectUri: `${window.location.origin}/auth/callback`,
		storage: window.sessionStorage,
	}),
});

if (import.meta.hot) {
	import.meta.hot.dispose(() => auth[Symbol.dispose]());
}
