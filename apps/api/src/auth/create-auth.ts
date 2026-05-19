import { oauthProvider } from '@better-auth/oauth-provider';
import { type BetterAuthOptions, betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { jwt } from 'better-auth/plugins/jwt';
import { eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { createAutumn } from '../autumn';
import { FEATURE_IDS } from '../billing-plans';
import * as schema from '../db/schema';
import { TRUSTED_ORIGINS } from '../trusted-origins';
import { BASE_AUTH_CONFIG } from './base-config';
import { createCookieAdvancedConfig } from './cookie-config';
import { trustedOAuthClientIds } from './trusted-oauth-clients';

type Db = NodePgDatabase<typeof schema>;

/**
 * Assemble and return a configured `betterAuth()` instance from runtime deps.
 *
 * Cloudflare Workers doesn't expose `env` or database connections at module scope,
 * so this defers Better Auth initialization to request time. The returned object is
 * the raw Better Auth instance, with no wrapper or additional abstraction.
 *
 * Wires up:
 * - Drizzle adapter (Postgres via Hyperdrive)
 * - Google OAuth + email/password (from {@link BASE_AUTH_CONFIG})
 * - Plugins: JWT (ES256), OAuth provider (PKCE)
 * - Autumn billing customer creation on user signup
 * - Cloudflare KV secondary storage for session caching
 *
 * `/api/session` is the single Epicenter session surface; this builder no longer
 * enriches `/auth/get-session` with encryption keys.
 */
export function createAuth({
	db,
	env,
	baseURL,
}: {
	db: Db;
	env: Cloudflare.Env;
	baseURL: string;
}) {
	const authOptionsBase = {
		...BASE_AUTH_CONFIG,
		database: drizzleAdapter(db, { provider: 'pg' }),
		baseURL,
		secret: env.BETTER_AUTH_SECRET,
		account: {
			...BASE_AUTH_CONFIG.account,
			// Better Auth's database strategy validates OAuth callbacks two ways:
			// 1. A verification record in Postgres (random token, single-use, 10min TTL)
			// 2. A signed state cookie set during the sign-in POST
			//
			// Layer 2 fails in our architecture. The sign-in POST is a cross-origin
			// fetch (opensidian.com → api.epicenter.so), and modern browsers block
			// third-party Set-Cookie from fetch responses, even with SameSite=None.
			// Chrome Privacy Sandbox, Safari ITP, and Firefox ETP all enforce this.
			// The cookie is never stored, so the callback can't read it back.
			//
			// Layer 1 (DB verification) is the primary security mechanism and is
			// unaffected. skipStateCookieCheck disables only layer 2.
			skipStateCookieCheck: true,
		},
		socialProviders: {
			google: {
				clientId: env.GOOGLE_CLIENT_ID,
				clientSecret: env.GOOGLE_CLIENT_SECRET,
			},
		},
		session: {
			expiresIn: 60 * 60 * 24 * 7,
			updateAge: 60 * 60 * 24,
			// Write sessions to Postgres (source of truth), not just KV.
			// Required when secondaryStorage is configured. See comment below.
			storeSessionInDatabase: true,
			cookieCache: {
				enabled: true,
				maxAge: 60 * 5,
				strategy: 'jwe',
			},
		},
		// Cookie transport for browser clients.
		//
		// Localhost uses host-only, non-secure Lax cookies so local dashboard
		// auth works through the Vite `/auth` proxy without a rejected Domain
		// or Secure attribute. Production uses SameSite=None + Secure so
		// browser apps can send cookies to api.epicenter.so from app origins.
		//
		// Cross-subdomain cookies are only enabled outside localhost. In
		// production, the cookie domain is .epicenter.so so Epicenter subdomains
		// share sessions. Apps on other domains still work because their fetches
		// target api.epicenter.so.
		//
		// NOTE: We intentionally omit `partitioned: true` (CHIPS).
		// Partitioned cookies are keyed by the top-level site at creation
		// time. During OAuth the top-level site changes mid-flow (client to
		// Google to API callback), so the cookie becomes invisible at the
		// callback step. Partitioned is for iframes, not redirect OAuth.
		advanced: createCookieAdvancedConfig(baseURL),
		databaseHooks: {
			user: {
				create: {
					after: async (user) => {
						const autumn = createAutumn(env);
						await autumn.customers.getOrCreate({
							customerId: user.id,
							email: user.email,
						});
					},
				},
				delete: {
					before: async (user) => {
						// Clean up R2 assets before CASCADE deletes Postgres rows
						const assets = await db
							.select({ id: schema.asset.id })
							.from(schema.asset)
							.where(eq(schema.asset.userId, user.id));

						if (assets.length > 0) {
							const keys = assets.map((a) => `${user.id}/${a.id}`);
							await env.ASSETS_BUCKET.delete(keys);
						}

						// Zero Autumn storage balance
						const autumn = createAutumn(env);
						await autumn.balances
							.update({
								customerId: user.id,
								featureId: FEATURE_IDS.storageBytes,
								usage: 0,
							})
							.catch((e) =>
								console.error('[user-delete] Autumn zero failed:', e),
							);
					},
				},
			},
		},
		trustedOrigins: TRUSTED_ORIGINS,
		// secondaryStorage = Cloudflare KV as a read-through cache.
		// Postgres (Germany) is always the source of truth. KV avoids the
		// ~150ms round-trip on repeated session reads from distant edges.
		//
		// Staleness: KV is eventually consistent, so cached entries may
		// briefly outlive their Postgres counterparts after deletion.
		//   - Sessions: a revoked session stays valid in KV for up to
		//     cookieCache.maxAge (5 min). Standard Redis/KV cache tradeoff.
		//   - Verification: a consumed OAuth state may linger in KV, but
		//     replaying it requires a valid Google authorization code that
		//     was already consumed, which is harmless.
		//
		// IMPORTANT: When secondaryStorage is configured, Better Auth
		// defaults to KV-only writes unless you opt back into Postgres
		// with storeSessionInDatabase / storeInDatabase. Missing either
		// flag causes silent data loss. If you remove secondaryStorage,
		// remove both flags too.
		secondaryStorage: {
			get: (key: string) => env.SESSION_KV.get(key),
			set: (key: string, value: string, ttl?: number) =>
				env.SESSION_KV.put(key, value, {
					expirationTtl: ttl ?? 60 * 5,
				}),
			delete: (key: string) => env.SESSION_KV.delete(key),
		},
		// Write verification records to Postgres, not just KV. Required
		// for OAuth state. KV eventual consistency means the callback edge
		// may not see a record written moments earlier at a different edge.
		verification: {
			storeInDatabase: true,
		},
	} satisfies Omit<BetterAuthOptions, 'plugins'>;

	return betterAuth({
		...authOptionsBase,
		plugins: [
			// ES256 (P-256 ECDSA) signs the id_token and JWT access tokens. The
			// jose default would be EdDSA (Ed25519); pinning ES256 gives the
			// broadest verifier-library support across browser `jose`, Tauri
			// Rust crates, and mobile platforms. The `id_token_signing_alg_values_supported`
			// claim on `/.well-known/openid-configuration` reflects this.
			jwt({ jwks: { keyPairConfig: { alg: 'ES256' } } }),
			oauthProvider({
				loginPage: '/sign-in',
				consentPage: '/consent',
				requirePKCE: true,
				cachedTrustedClients: trustedOAuthClientIds,
				validAudiences: [baseURL],
				allowDynamicClientRegistration: false,
				scopes: [
					'openid',
					'profile',
					'email',
					'offline_access',
					'workspaces:open',
				],
				// The plugin warns that /.well-known/oauth-authorization-server/auth must exist
				// because basePath is /auth (not /), so it can't auto-mount at the root.
				// We already mount both discovery endpoints manually in app.ts.
				silenceWarnings: { oauthAuthServerConfig: true, openidConfig: true },
			}),
		],
	});
}
