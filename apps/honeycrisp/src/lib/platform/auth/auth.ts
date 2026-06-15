import { createWebStoragePersistedAuthStorage } from '@epicenter/auth';
import { createBrowserOAuthLauncher } from '@epicenter/auth/oauth-launchers';
import { EPICENTER_HONEYCRISP_OAUTH_CLIENT_ID } from '@epicenter/constants/oauth-clients';
import { APP_URLS } from '@epicenter/constants/vite';
import { createOAuthAppAuth } from '@epicenter/svelte/auth';

export const auth = createOAuthAppAuth({
	baseURL: APP_URLS.API,
	clientId: EPICENTER_HONEYCRISP_OAUTH_CLIENT_ID,
	persistedAuthStorage: createWebStoragePersistedAuthStorage({
		key: 'honeycrisp.auth.persisted',
		storage: window.localStorage,
	}),
	launcher: createBrowserOAuthLauncher({
		issuer: `${APP_URLS.API}/auth`,
		clientId: EPICENTER_HONEYCRISP_OAUTH_CLIENT_ID,
		redirectUri: `${window.location.origin}/auth/callback`,
		resource: APP_URLS.API,
		storage: window.sessionStorage,
	}),
});

if (import.meta.hot) {
	import.meta.hot.dispose(() => auth[Symbol.dispose]());
}
