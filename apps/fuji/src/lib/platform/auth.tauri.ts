import { createWebStoragePersistedAuthStorage } from '@epicenter/auth';
import {
	createOAuthClient,
	OAuthClientError,
	type OAuthLauncher,
	type OAuthLaunchResult,
} from '@epicenter/auth/oauth-launchers';
import {
	EPICENTER_FUJI_OAUTH_CLIENT_ID,
	EPICENTER_FUJI_TAURI_OAUTH_REDIRECT_URI,
} from '@epicenter/constants/oauth-clients';
import {
	createInstanceTokenAuth,
	createOAuthAppAuth,
} from '@epicenter/svelte/auth';
import type { UnlistenFn } from '@tauri-apps/api/event';
import { getCurrent, onOpenUrl } from '@tauri-apps/plugin-deep-link';
import { openUrl } from '@tauri-apps/plugin-opener';
import { Ok, type Result } from 'wellcrafted/result';
import { instanceSetting } from '$lib/instance';
import type { PlatformAuth } from './types';

const OAUTH_CALLBACK_TIMEOUT_MS = 10 * 60 * 1000;

const instance = instanceSetting.readInstance();

// A configured instance token means a self-hosted star: authenticate with the
// static bearer (ADR-0070) instead of OAuth. Otherwise the deep-link OAuth flow
// runs against the instance origin, which is the hosted cloud by default.
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
			launcher: createFujiOAuthLauncher(instance.baseURL),
		});

if (import.meta.hot) {
	import.meta.hot.dispose(() => auth[Symbol.dispose]());
}

function createFujiOAuthLauncher(baseURL: string): OAuthLauncher {
	const redirectUri = EPICENTER_FUJI_TAURI_OAUTH_REDIRECT_URI;
	const client = createOAuthClient({
		issuer: `${baseURL}/auth`,
		clientId: EPICENTER_FUJI_OAUTH_CLIENT_ID,
		resource: baseURL,
		// Deep-link callbacks can cold-start the app; sessionStorage would lose
		// the PKCE transaction.
		storage: window.localStorage,
	});

	return {
		async startSignIn() {
			const currentUrls = await getCurrent().catch(() => null);
			const currentCallback = currentUrls?.find((url) =>
				isRedirectUrl(url, redirectUri),
			);
			if (currentCallback) {
				const callbackResult = await client.exchangeCallback(currentCallback);
				if (callbackResult.error) return callbackResult;
				return Ok({
					status: 'completed',
					grant: callbackResult.data,
				} satisfies OAuthLaunchResult);
			}

			const urlResult = await client.createAuthorizationUrl(redirectUri);
			if (urlResult.error) return urlResult;

			const callbackUrl = await waitForRedirectUrl({
				authorizationUrl: urlResult.data.toString(),
				redirectUri,
			});
			if (callbackUrl.error) return callbackUrl;

			const callbackResult = await client.exchangeCallback(callbackUrl.data);
			if (callbackResult.error) return callbackResult;
			return Ok({
				status: 'completed',
				grant: callbackResult.data,
			} satisfies OAuthLaunchResult);
		},
	} satisfies OAuthLauncher;
}

// Tauri can deliver arbitrary URLs for the registered scheme. Claim only the
// exact OAuth redirect endpoint when it carries an OAuth callback payload.
function isRedirectUrl(url: string, redirectUri: string): boolean {
	if (url !== redirectUri && !url.startsWith(`${redirectUri}?`)) return false;
	try {
		const callbackUrl = new URL(url);
		return (
			callbackUrl.searchParams.has('code') ||
			callbackUrl.searchParams.has('error')
		);
	} catch {
		return false;
	}
}

// Install the deep-link listener before opening the browser, then resolve the
// first matching callback URL. Token exchange happens after URL capture.
function waitForRedirectUrl({
	authorizationUrl,
	redirectUri,
}: {
	authorizationUrl: string;
	redirectUri: string;
}): Promise<Result<string, OAuthClientError>> {
	return new Promise<Result<string, OAuthClientError>>((resolve) => {
		let settled = false;
		let unlisten: UnlistenFn | null = null;

		const settle = (result: Result<string, OAuthClientError>) => {
			if (settled) return;
			settled = true;
			window.clearTimeout(timeout);
			unlisten?.();
			resolve(result);
		};

		const timeout = window.setTimeout(() => {
			settle(
				OAuthClientError.LaunchFailed({
					cause: new Error('Timed out waiting for OAuth callback.'),
				}),
			);
		}, OAUTH_CALLBACK_TIMEOUT_MS);

		onOpenUrl((urls) => {
			if (settled) return;
			const callbackUrl = urls.find((url) => isRedirectUrl(url, redirectUri));
			if (!callbackUrl) return;
			settle(Ok(callbackUrl));
		})
			.then((nextUnlisten) => {
				unlisten = nextUnlisten;
				return openUrl(authorizationUrl);
			})
			.catch((cause) => {
				settle(OAuthClientError.LaunchFailed({ cause }));
			});
	});
}
