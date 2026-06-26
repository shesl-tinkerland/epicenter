import { asOwnerId } from '@epicenter/identity';
import { type BetterAuthOptions, betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '../db/schema/index.js';
import { BASE_AUTH_CONFIG } from './base-config.js';
import { createCookieAdvancedConfig } from './cookie-config.js';
import { authPlugins } from './plugins.js';
import {
	configuredSocialProviders,
	type OAuthProviderEnv,
} from './social-providers.js';

type Db = NodePgDatabase<typeof schema>;

/**
 * The secrets `createAuth` actually reads. Loosened from `Cloudflare.Env` to
 * exactly this (ADR-0066): every member is a portable string the runtimes
 * expose identically (`c.env` on Workers, `process.env` on a Node host). Auth
 * construction thus names no Cloudflare binding type at all. A deployment's
 * `Cloudflare.Env` satisfies this structurally.
 *
 * Every OAuth provider is optional and register-when-present (ADR-0071): a
 * deployment configures the ones it has an app for, or none at all (the solo
 * self-host box, which authenticates with a first-boot bearer instead). The
 * configured set is computed by {@link configuredSocialProviders}.
 */
type AuthEnv = OAuthProviderEnv & {
	BETTER_AUTH_SECRET: string;
};

/**
 * Assemble and return a configured `betterAuth()` instance from runtime deps.
 *
 * Cloudflare Workers doesn't expose `env` or database connections at module scope,
 * so this defers Better Auth initialization to request time. The returned object is
 * the raw Better Auth instance, with no wrapper or additional abstraction.
 *
 * Wires up:
 * - Drizzle adapter (portable Postgres wire; Hyperdrive on Workers, a pool on Node)
 * - Google OAuth, plus GitHub when its credentials are configured
 *   (email/password is disabled; see {@link BASE_AUTH_CONFIG})
 * - Plugins: JWT (ES256), OAuth provider (PKCE)
 * - Cleanup hook that clears the deleted user's owner-partitioned rows
 *
 * `/api/session` is the single Epicenter session surface; this builder no longer
 * enriches `/auth/get-session` with encryption keys.
 */
export function createAuth({
	db,
	env,
	baseURL,
	trustedOrigins,
	cookieCrossSubDomain,
}: {
	db: Db;
	env: AuthEnv;
	baseURL: string;
	/** Deployment-supplied trusted origins (CORS, CSRF, redirect allow-list). */
	trustedOrigins: string[];
	/**
	 * Registrable domain for cross-subdomain session cookies, when the
	 * deployment shares sessions across subdomains. Omitted for a single-origin
	 * deployment, which then uses host-only cookies.
	 */
	cookieCrossSubDomain?: string;
}) {
	return betterAuth({
		...BASE_AUTH_CONFIG,
		database: drizzleAdapter(db, { provider: 'pg', schema }),
		baseURL,
		secret: env.BETTER_AUTH_SECRET,
		// `account` (accountLinking) comes from BASE_AUTH_CONFIG via the spread.
		//
		// The Better Auth state-cookie check stays ENABLED (its default). The
		// Google sign-in leg validates the callback two ways: a single-use
		// Postgres verification record AND a signed state cookie set during the
		// sign-in POST. An earlier note disabled the cookie check on the theory
		// that the sign-in POST was a cross-origin fetch whose third-party
		// Set-Cookie browsers would drop. That is not how this deploys: the only
		// caller of `/auth/sign-in/social` is the API-hosted sign-in page
		// (auth-pages/scripts/sign-in.ts), which fetches a same-origin relative
		// URL, so the state cookie is first-party, stored, and sent on the
		// Google callback navigation. The cookie binds the callback to the
		// initiating browser (the DB record alone does not), so keeping the check
		// on restores that login-CSRF / session-fixation defense.
		// Each provider is registered only when its credentials are configured
		// (configuredSocialProviders): the hosted star runs Google, the shared wiki
		// runs whichever providers its operator set, and a solo self-host box runs
		// none and authenticates with a first-boot bearer instead (ADR-0072). A
		// provider with no app configured is simply absent, never a button that
		// 500s. better-auth requests `read:user` + `user:email` for GitHub by
		// default, so it reads the primary email and GitHub's verification flag.
		socialProviders: configuredSocialProviders(env),
		session: {
			expiresIn: 60 * 60 * 24 * 7,
			updateAge: 60 * 60 * 24,
			// Postgres is the session store. A 5-minute encrypted (JWE) cookie
			// cache absorbs repeat reads, so most authed requests skip the DB
			// entirely; a cache miss falls back to Postgres.
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
		advanced: createCookieAdvancedConfig(baseURL, cookieCrossSubDomain),
		databaseHooks: {
			user: {
				delete: {
					before: async (user) => {
						// Partition cleanup. In personal mode `owner_id === user.id`
						// so this deletes the user's DOI rows. In shared mode
						// `owner_id === 'shared' !== user.id` so the query no-ops and
						// shared data survives admission churn. Without an FK + cascade,
						// the row delete is explicit here. (Content-addressed blob bytes
						// live owner-prefixed in object storage with no DB row; an
						// occasional LIST sweep reclaims an orphaned owner prefix.)
						const ownerId = asOwnerId(user.id);

						await db
							.delete(schema.durableObjectInstance)
							.where(eq(schema.durableObjectInstance.ownerId, ownerId));
					},
				},
			},
		},
		trustedOrigins,
		// Postgres is the only auth store: sessions and OAuth verification
		// records persist to the DB adapter by default (no secondaryStorage), and
		// the JWE cookie cache above handles read performance. This makes auth
		// construction byte-identical on Workers and a Node host (Road 1: depend
		// on the portable Postgres path, delete the KV-cache divergence).
		//
		// Rate limiting consequently runs in-process, not in a shared store:
		// dropping KV flips Better Auth's default from "secondary-storage" to
		// "memory", so on the Worker each isolate keeps its own counters.
		// Acceptable here because email/password is disabled and Google is the
		// only sign-in (see BASE_AUTH_CONFIG), so there is no password
		// brute-force surface a shared counter would protect; a single self-host
		// process gets exact in-memory limiting for free. Upgrade trigger: add a
		// `rateLimit` table to the schema and set `storage: 'database'` if
		// durable, shared limiting is ever needed.
		rateLimit: { storage: 'memory' },
		plugins: authPlugins(baseURL),
	} satisfies BetterAuthOptions);
}
