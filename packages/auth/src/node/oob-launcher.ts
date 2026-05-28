/**
 * Out-of-band (OOB) OAuth 2.1 authorization-code launcher for the CLI.
 *
 * Prints an authorize URL, optionally opens it in the user's browser,
 * waits for the user to paste the one-time code from
 * `https://api.epicenter.so/auth/cli-callback`, then exchanges the code
 * at `/auth/oauth2/token` with PKCE. Returns a completed OAuth launch result
 * containing a 3-field `OAuthTokenGrant`.
 *
 * The launcher is concerned only with the OAuth dance. The caller pairs
 * the returned grant with `GET /api/session` to fill in the `userId`,
 * `ownerId`, and `keyring` fields of `PersistedAuth`.
 */

import * as readline from 'node:readline';
import { EPICENTER_API_URL } from '@epicenter/constants/apps';
import { EPICENTER_OAUTH_SCOPES } from '@epicenter/constants/oauth';
import { OAUTH_ROUTES } from '@epicenter/constants/oauth-routes';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { Err, Ok, type Result } from 'wellcrafted/result';
import type { AuthFetch } from '../create-oauth-app-auth.js';
import type {
	OAuthLauncher,
	OAuthLaunchResult,
} from '../oauth-launchers/contract.js';
import { parseOAuthTokenGrant } from '../oauth-token-response.js';

/**
 * CLI transport failures before machine auth can persist a session.
 *
 * These errors intentionally describe OOB mechanics only: browser opening,
 * pasted-code cancellation, and token endpoint response shape. `/api/session`
 * identity lookup belongs to `loginWithOob`.
 */
export const OobLauncherError = defineErrors({
	TokenExchangeFailed: ({
		status,
		body,
		cause,
	}: {
		status: number;
		body: string;
		cause?: unknown;
	}) => ({
		message: `OAuth token exchange failed with status ${status}: ${body}`,
		status,
		body,
		cause,
	}),
	InvalidTokenResponse: ({ cause }: { cause: unknown }) => ({
		message: `Invalid OAuth token response: ${extractErrorMessage(cause)}`,
		cause,
	}),
	AuthorizationCancelled: () => ({
		message: 'No code pasted. Cancelled.',
	}),
});

export type OobLauncherError = InferErrors<typeof OobLauncherError>;

export type CreateOobOAuthLauncherConfig = {
	/**
	 * Epicenter API origin. The default points at production.
	 */
	baseURL?: string;
	/**
	 * Public OAuth client id for CLI login.
	 */
	clientId: string;
	/**
	 * OOB callback registered for this API deployment.
	 *
	 * Production callers should use the default. Tests and local deployments pass
	 * this only when the trusted OAuth client table was seeded with a different
	 * callback URL.
	 */
	redirectUri?: string;
	/**
	 * OAuth scopes requested by the CLI. Defaults to Epicenter's app-client scope.
	 */
	scopes?: readonly string[];
	/**
	 * Best-effort browser opener. The printed URL remains the source of truth.
	 */
	openBrowser?: (url: string) => Promise<void> | void;
	/**
	 * Reads the one-time code pasted from the hosted CLI callback page.
	 */
	readCode?: () => Promise<string>;
	/**
	 * Output sink for the authorize URL and paste prompt.
	 */
	print?: (line: string) => void;
	/**
	 * Fetch implementation used only for the token exchange.
	 */
	fetch?: AuthFetch;
	/**
	 * Crypto implementation used for PKCE verifier and challenge generation.
	 */
	crypto?: Crypto;
	/**
	 * Clock used to convert `expires_in` into the persisted grant refresh hint.
	 */
	now?: () => number;
};

/**
 * Create the CLI out-of-band OAuth launcher.
 *
 * Use this for one-shot human login from terminals where a localhost callback
 * is not guaranteed. It prints the authorize URL, exchanges the pasted code
 * with PKCE, and returns a completed launch result with the OAuth grant. The
 * caller must still call `/api/session` before persisting anything, preserving
 * the split between network credentials and local workspace identity.
 */
export function createOobOAuthLauncher({
	baseURL = EPICENTER_API_URL,
	clientId,
	redirectUri = OAUTH_ROUTES.cliCallback.url(baseURL),
	scopes = EPICENTER_OAUTH_SCOPES,
	openBrowser = defaultOpenBrowser,
	readCode = defaultReadCode,
	print = (line) => console.log(line),
	fetch = globalThis.fetch.bind(globalThis),
	crypto = globalThis.crypto,
	now = Date.now,
}: CreateOobOAuthLauncherConfig): OAuthLauncher {
	return {
		async startSignIn(): Promise<Result<OAuthLaunchResult, OobLauncherError>> {
			const verifierBytes = new Uint8Array(32);
			crypto.getRandomValues(verifierBytes);
			const codeVerifier = base64UrlEncode(verifierBytes);
			const challengeBytes = new Uint8Array(
				await crypto.subtle.digest(
					'SHA-256',
					new TextEncoder().encode(codeVerifier),
				),
			);
			const codeChallenge = base64UrlEncode(challengeBytes);
			const authorizeUrl = new URL(OAUTH_ROUTES.authorize.url(baseURL));
			authorizeUrl.search = new URLSearchParams({
				response_type: 'code',
				client_id: clientId,
				redirect_uri: redirectUri,
				scope: scopes.join(' '),
				code_challenge: codeChallenge,
				code_challenge_method: 'S256',
				resource: baseURL,
			}).toString();

			print(authorizeUrl.toString());
			print(
				'Open the URL above to sign in, then paste the code shown on the success page:',
			);

			try {
				await openBrowser(authorizeUrl.toString());
			} catch {
				// best-effort; the printed URL is the source of truth
			}

			const pastedCode = (await readCode()).trim();
			if (pastedCode === '') {
				return Err(OobLauncherError.AuthorizationCancelled().error);
			}

			let response: Response;
			try {
				response = await fetch(OAUTH_ROUTES.token.url(baseURL), {
					method: 'POST',
					headers: { 'content-type': 'application/x-www-form-urlencoded' },
					credentials: 'omit',
					body: new URLSearchParams({
						grant_type: 'authorization_code',
						code: pastedCode,
						code_verifier: codeVerifier,
						client_id: clientId,
						redirect_uri: redirectUri,
						resource: baseURL,
					}),
				});
			} catch (cause) {
				return Err(
					OobLauncherError.TokenExchangeFailed({
						status: 0,
						body: extractErrorMessage(cause),
						cause,
					}).error,
				);
			}

			if (!response.ok) {
				let body = '';
				try {
					body = await response.text();
				} catch {
					// fall through with empty body
				}
				return Err(
					OobLauncherError.TokenExchangeFailed({
						status: response.status,
						body,
					}).error,
				);
			}

			let payload: unknown;
			try {
				payload = await response.json();
			} catch (cause) {
				return Err(OobLauncherError.InvalidTokenResponse({ cause }).error);
			}

			const { data: grant, error } = parseOAuthTokenGrant(payload, { now });
			if (error) {
				return Err(
					OobLauncherError.InvalidTokenResponse({ cause: error }).error,
				);
			}
			return Ok({ status: 'completed', grant } satisfies OAuthLaunchResult);
		},
	};
}

function base64UrlEncode(bytes: Uint8Array): string {
	let binary = '';
	for (let i = 0; i < bytes.byteLength; i += 1) {
		binary += String.fromCharCode(bytes[i] as number);
	}
	const base64 =
		typeof btoa === 'function'
			? btoa(binary)
			: Buffer.from(bytes).toString('base64');
	return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '');
}

async function defaultOpenBrowser(url: string): Promise<void> {
	const command = pickOpenCommand();
	if (!command) return;
	try {
		// Bun.spawn is available in the CLI runtime. Failure is best-effort.
		const proc = (
			globalThis as unknown as {
				Bun?: { spawn: (cmd: string[]) => unknown };
			}
		).Bun?.spawn([...command, url]);
		void proc;
	} catch {
		// swallow; the printed URL is the source of truth
	}
}

function pickOpenCommand(): string[] | null {
	switch (process.platform) {
		case 'darwin':
			return ['open'];
		case 'win32':
			return ['cmd', '/c', 'start', ''];
		case 'linux':
		case 'freebsd':
		case 'openbsd':
		case 'sunos':
			return ['xdg-open'];
		default:
			return null;
	}
}

function defaultReadCode(): Promise<string> {
	return new Promise((resolve) => {
		const rl = readline.createInterface({
			input: process.stdin,
			output: process.stdout,
			terminal: false,
		});
		rl.question('Paste the code from the success page here: ', (line) => {
			rl.close();
			resolve(line);
		});
	});
}
