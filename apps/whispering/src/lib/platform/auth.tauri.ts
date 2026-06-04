import { createWebStoragePersistedAuthStorage } from '@epicenter/auth';
import { createTauriDeepLinkOAuthLauncher } from '@epicenter/auth/oauth-launchers/tauri';
import {
	EPICENTER_WHISPERING_OAUTH_CLIENT_ID,
	EPICENTER_WHISPERING_TAURI_OAUTH_REDIRECT_URI,
} from '@epicenter/constants/oauth';
import { APP_URLS } from '@epicenter/constants/vite';
import { createOAuthAppAuth } from '@epicenter/svelte/auth';
import type { PlatformAuth } from './types';

export const auth: PlatformAuth = createOAuthAppAuth({
	baseURL: APP_URLS.API,
	clientId: EPICENTER_WHISPERING_OAUTH_CLIENT_ID,
	persistedAuthStorage: createWebStoragePersistedAuthStorage({
		key: 'whispering.auth.persisted',
		storage: window.localStorage,
	}),
	launcher: createTauriDeepLinkOAuthLauncher({
		issuer: `${APP_URLS.API}/auth`,
		clientId: EPICENTER_WHISPERING_OAUTH_CLIENT_ID,
		resource: APP_URLS.API,
		redirectUri: EPICENTER_WHISPERING_TAURI_OAUTH_REDIRECT_URI,
		// Deep-link callbacks can cold-start the app; localStorage (not
		// sessionStorage) keeps the PKCE transaction alive across the launch.
		storage: window.localStorage,
	}),
});

if (import.meta.hot) {
	import.meta.hot.dispose(() => auth[Symbol.dispose]());
}
