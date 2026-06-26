import { createWebStoragePersistedAuthStorage } from '@epicenter/auth';
import { createBrowserOAuthLauncher } from '@epicenter/auth/oauth-launchers';
import { EPICENTER_FUJI_OAUTH_CLIENT_ID } from '@epicenter/constants/oauth-clients';
import {
	createInstanceTokenAuth,
	createOAuthAppAuth,
} from '@epicenter/svelte/auth';
import { instanceSetting } from '$lib/instance';
import type { PlatformAuth } from './types';

const instance = instanceSetting.readInstance();

// A configured instance token means a self-hosted star: authenticate with the
// static bearer (ADR-0070) instead of OAuth. Otherwise the OAuth flow runs
// against the instance origin, which is the hosted cloud by default.
export const auth: PlatformAuth = instance.token
	? createInstanceTokenAuth({
			baseURL: instance.baseURL,
			token: instance.token,
		})
	: createOAuthAppAuth({
			baseURL: instance.baseURL,
			clientId: EPICENTER_FUJI_OAUTH_CLIENT_ID,
			persistedAuthStorage: createWebStoragePersistedAuthStorage({
				key: 'fuji.auth.persisted',
				storage: window.localStorage,
			}),
			launcher: createBrowserOAuthLauncher({
				issuer: `${instance.baseURL}/auth`,
				clientId: EPICENTER_FUJI_OAUTH_CLIENT_ID,
				resource: instance.baseURL,
				redirectUri: `${window.location.origin}/auth/callback`,
				storage: window.sessionStorage,
			}),
		});

if (import.meta.hot) {
	import.meta.hot.dispose(() => auth[Symbol.dispose]());
}
