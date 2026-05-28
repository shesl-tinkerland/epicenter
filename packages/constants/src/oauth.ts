import type { SchemaClient } from '@better-auth/oauth-provider';
import { APPS, localUrl } from '#apps';

/**
 * Dev port for the dashboard SPA. The dashboard is served at
 * `api.epicenter.so/dashboard` in production (same origin as the API), so it
 * has no `APPS` entry. In dev it runs on its own Vite server; this port is
 * the single source of truth, mirrored by `apps/dashboard/vite.config.ts`.
 */
const DASHBOARD_DEV_PORT = 5178;

/**
 * Shape of one checked-in first-party public OAuth client.
 *
 * Better Auth calls server-side confidential clients `web`. Epicenter's
 * checked-in trusted clients are public PKCE clients
 * (`tokenEndpointAuthMethod: 'none'`, `public: true`, no client secret), so
 * Better Auth only accepts `native` and `user-agent-based` for this policy.
 * The API seed layer fills in the rest (PKCE required, consent skipped,
 * authorization-code flow, Epicenter scopes).
 *
 * `redirectUris` is the final resolved list for a specific deployment,
 * built by {@link buildTrustedOAuthClients} from `APPS` plus the
 * deployment's API base URL.
 *
 * Field names stay spelled out instead of using `Pick` or a mapped type so
 * this file reads as config. The Better Auth indexed types keep the field
 * names tied to upstream without making the shape cryptic.
 */
export type TrustedOAuthClient = {
	clientId: NonNullable<SchemaClient['clientId']>;
	name: NonNullable<SchemaClient['name']>;
	type: Extract<
		NonNullable<SchemaClient['type']>,
		'native' | 'user-agent-based'
	>;
	redirectUris: readonly string[];
};

/**
 * OAuth public client id for `epicenter auth login`.
 *
 * The CLI uses an out-of-band (OOB) authorization-code + PKCE flow against
 * the same `/auth/oauth2/token` endpoint the browser uses. After sign-in
 * on the hosted portal, Better Auth redirects to the API origin's
 * `/auth/cli-callback`, which renders the one-time code; the user pastes
 * it into the terminal. This identifies the CLI app type, not a user,
 * machine, install, or secret. Every CLI install uses the same value.
 */
export const EPICENTER_CLI_OAUTH_CLIENT_ID = 'epicenter-cli';

export const EPICENTER_DASHBOARD_OAUTH_CLIENT_ID = 'epicenter-dashboard';
export const EPICENTER_FUJI_OAUTH_CLIENT_ID = 'epicenter-fuji';
export const EPICENTER_FUJI_TAURI_OAUTH_REDIRECT_URI =
	'epicenter-fuji://auth/callback';
export const EPICENTER_HONEYCRISP_OAUTH_CLIENT_ID = 'epicenter-honeycrisp';
export const EPICENTER_OPENSIDIAN_OAUTH_CLIENT_ID = 'epicenter-opensidian';
export const EPICENTER_TAB_MANAGER_OAUTH_CLIENT_ID = 'epicenter-tab-manager';
export const EPICENTER_ZHONGWEN_OAUTH_CLIENT_ID = 'epicenter-zhongwen';

export const EPICENTER_OAUTH_SCOPES = [
	'openid',
	'profile',
	'email',
	'offline_access',
] as const;

export const EPICENTER_OAUTH_SCOPE = EPICENTER_OAUTH_SCOPES.join(' ');

/**
 * Every redirect URI for an app: the dev `http://localhost:<port>` origin
 * plus every entry in `APPS[*].urls`, each joined to `path`. Used for apps
 * that own their origin (Fuji, Honeycrisp, Opensidian, Zhongwen).
 */
function appCallbacks(
	app: { port: number; urls: readonly string[] },
	path: string,
): string[] {
	return [localUrl(app), ...app.urls].map((origin) => `${origin}${path}`);
}

/**
 * Build the checked-in trusted public OAuth clients for a specific
 * deployment. Each client's `redirectUris` resolve against either the app's
 * own origins (Fuji, Honeycrisp, etc.) or the deployment's API base URL
 * (Dashboard and CLI, which both live on the API origin). A self-host at
 * `https://api.acme.com` and `wrangler dev` on a custom port each register
 * their own callbacks without anyone editing this file.
 *
 * The API seed (`ensureTrustedOAuthClients`) calls this once per worker at
 * cold boot; `authPlugins` calls it to derive the trusted-client-id set.
 */
export function buildTrustedOAuthClients(apiBaseURL: string) {
	return [
		{
			clientId: EPICENTER_DASHBOARD_OAUTH_CLIENT_ID,
			name: 'Epicenter Dashboard',
			type: 'user-agent-based',
			redirectUris: [
				`${apiBaseURL}/dashboard/auth/callback`,
				`http://localhost:${DASHBOARD_DEV_PORT}/dashboard/auth/callback`,
			],
		},
		{
			clientId: EPICENTER_FUJI_OAUTH_CLIENT_ID,
			name: 'Fuji',
			type: 'user-agent-based',
			redirectUris: [
				...appCallbacks(APPS.FUJI, '/auth/callback'),
				EPICENTER_FUJI_TAURI_OAUTH_REDIRECT_URI,
			],
		},
		{
			clientId: EPICENTER_HONEYCRISP_OAUTH_CLIENT_ID,
			name: 'Honeycrisp',
			type: 'user-agent-based',
			redirectUris: appCallbacks(APPS.HONEYCRISP, '/auth/callback'),
		},
		{
			clientId: EPICENTER_OPENSIDIAN_OAUTH_CLIENT_ID,
			name: 'Opensidian',
			type: 'user-agent-based',
			redirectUris: appCallbacks(APPS.OPENSIDIAN, '/auth/callback'),
		},
		{
			clientId: EPICENTER_TAB_MANAGER_OAUTH_CLIENT_ID,
			name: 'Tab Manager extension',
			type: 'user-agent-based',
			redirectUris: ['chrome-extension://mkbnicfhpacdofmoocppnjjmdfmkkgda/'],
		},
		{
			clientId: EPICENTER_ZHONGWEN_OAUTH_CLIENT_ID,
			name: 'Zhongwen',
			type: 'user-agent-based',
			redirectUris: appCallbacks(APPS.ZHONGWEN, '/auth/callback'),
		},
		{
			clientId: EPICENTER_CLI_OAUTH_CLIENT_ID,
			name: 'Epicenter CLI',
			type: 'native',
			redirectUris: [`${apiBaseURL}/auth/cli-callback`],
		},
	] as const satisfies readonly TrustedOAuthClient[];
}
