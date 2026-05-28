import { PersistedAuth } from '@epicenter/auth';
import { createBrowserOAuthLauncher } from '@epicenter/auth/oauth-launchers';
import { createOAuthAppAuth } from '@epicenter/auth-svelte';
import { EPICENTER_FUJI_OAUTH_CLIENT_ID } from '@epicenter/constants/oauth';
import { APP_URLS } from '@epicenter/constants/vite';
import { createPersistedState } from '@epicenter/svelte';

export const auth = createOAuthAppAuth({
	baseURL: APP_URLS.API,
	clientId: EPICENTER_FUJI_OAUTH_CLIENT_ID,
	persistedAuthStorage: createPersistedState({
		key: 'fuji.auth.persisted',
		schema: PersistedAuth.or('null'),
		defaultValue: null,
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
