/**
 * Epicenter Cloud Worker entry.
 *
 * Composes `@epicenter/server` with the `personal` ownership rule and
 * layers cloud-only billing, admin, and dashboard surfaces on top.
 * The self-hosted single-partition instance lives in a sibling apps/* folder
 * and composes the same library with `instance()` and no Autumn policies
 * (ADR-0075).
 *
 * Read top to bottom for the full URL surface of cloud. Each `mount*`
 * call bundles the auth + ownership + policies + route mount for one
 * reusable surface; the deployment passes only the deployment-controlled
 * knobs (ownership rule, optional cloud policies, auth choice for AI).
 */

import { PRODUCTION_API_URL } from '@epicenter/constants/apps';
import {
	type CloudEnv,
	connectHyperdriveDb,
	createDurableObjectRooms,
	createServerApp,
	mountBlobsApp,
	mountCloudAuth,
	mountCloudDb,
	mountInferenceApp,
	mountRoomsApp,
	mountSessionApp,
	mountTranscriptionApp,
	personal,
	Room,
	requireBearerUser,
	requireCookieOrBearerUser,
	resolveRequestOAuthUser,
	type ServerBindings,
} from '@epicenter/server';
import { describeRoute } from 'hono-openapi';
import {
	chargeOpenAiCreditsWithAutumn,
	chargeOpenAiTranscriptionCredits,
} from './billing/policies.js';
import { mountBillingApi } from './billing/routes.js';
import { buildEpicenterTrustedOrigins } from './trusted-origins.js';

// Compile-time proof that this worker's generated Env provides every
// binding the library reads. A missing or mistyped binding fails here,
// not deep inside library files compiled in this program.
({}) as Cloudflare.Env satisfies ServerBindings;

const ownership = personal();

const app = createServerApp<CloudEnv>({
	// The one runtime-specific portable concern: bind this Worker's Durable Object
	// room registry. The `Cloudflare.Env` cast and the binding name live here, at
	// the app edge, type-checked against this Worker's generated bindings (ADR-0066).
	// Per-room DO sharding stays the cloud's binding of the room actor forever:
	// hibernate-to-zero and single-writer-per-room at multi-tenant scale. The cloud's
	// Postgres + `waitUntil` are NOT here; they are installed by `mountCloudDb` below.
	resolveRooms: (env) => createDurableObjectRooms((env as Cloudflare.Env).ROOM),
	identity: {
		// The hosted cloud's public origin never changes per deploy, so it is
		// baked from the constants source of truth rather than duplicated into
		// wrangler.jsonc vars. Local dev injects
		// `API_PUBLIC_ORIGIN=http://localhost:8787` via scripts/dev.ts; production
		// falls through to PRODUCTION_API_URL. `API_PUBLIC_ORIGIN` is
		// deployment-owned config, not a binding `ServerBindings` names, so casting
		// to this deployment's own `Cloudflare.Env` is the honest edge (ADR-0066).
		resolveOrigin: (env) =>
			(env as Cloudflare.Env).API_PUBLIC_ORIGIN ?? PRODUCTION_API_URL,
		resolveTrustedOrigins: buildEpicenterTrustedOrigins,
	},
});

// The cloud resolves a request to its user by verifying an OAuth bearer against
// JWKS (`resolveRequestOAuthUser` reads `c.var.auth` + `c.var.db`, both present
// below). Each owner-scoped wrapper closes over that one resolver; an instance
// closes over its env-token resolver instead (ADR-0075).
const cookieOrBearer = requireCookieOrBearerUser(resolveRequestOAuthUser);
const bearer = requireBearerUser(resolveRequestOAuthUser);

// Public health endpoint at root.
app.get('/', (c) =>
	c.json({ product: 'hub', version: '0.1.0', runtime: 'cloudflare' }),
);

// Cloud-only Postgres lifecycle: a per-request pg client over Hyperdrive +
// `waitUntil` to keep billing's after-response drain alive. Installed first so
// `c.var.db` is set before Better Auth (and any billing handler) reads it. The
// instance composes no Postgres and never calls this (ADR-0076). The binding name
// and `Cloudflare.Env` cast live at this edge, type-checked against this Worker's
// generated bindings (ADR-0066).
mountCloudDb(app, {
	connect: (env) => connectHyperdriveDb((env as Cloudflare.Env).HYPERDRIVE),
	afterResponse: (c, work) => c.executionCtx.waitUntil(work),
});

// Cloud-only relational-auth layer: per-request Better Auth on `c.var.auth`
// plus the auth surface (sign-in, consent, OAuth metadata). Session cookies are
// host-only to api.epicenter.so and consumed only by the dashboard the API
// serves itself; every other client is a bearer client (ADR-0079).
// Mounted before the owner-scoped surfaces so `c.var.auth` is set when their
// cookie-or-bearer wrappers run. The single-partition instance composes none of
// this (ADR-0075). The Cloud-only auth secrets are read at this Worker's own edge
// from its deploy-gated bindings (`c.env as Cloudflare.Env`), never the portable
// `ServerBindings` (ADR-0076/0066).
// ROLLOUT SHIM, delete after 2026-07-15. Sessions minted before the host-only
// cookie change carried `Domain=.epicenter.so`. A domain cookie and the new
// host-only cookie coexist under the same name, the browser sends the stale
// domain cookie first (created earlier), and sign-out clears only the host-only
// one, so the stale session would keep winning. The Cookie header cannot say
// which scope a value came from, so whenever a session cookie is present at
// all, append an expiring Set-Cookie for the old domain scope (deleting a
// domain cookie requires matching Domain + Path; this cannot touch the
// host-only cookie). Sessions live 7 days, so every legacy cookie is dead by
// the delete-after date. Registered BEFORE mountCloudAuth so it wraps the
// auth routes: Hono runs the chain in registration order, and a handler that
// responds ends it, so anything registered after a route never sees its
// requests.
const LEGACY_COOKIE_DOMAIN = '.epicenter.so';
const LEGACY_COOKIE_NAMES = [
	'__Secure-better-auth.session_token',
	'__Secure-better-auth.session_data',
];
app.use('*', async (c, next) => {
	await next();
	const cookieHeader = c.req.header('cookie');
	if (!cookieHeader) return;
	for (const name of LEGACY_COOKIE_NAMES) {
		if (!cookieHeader.includes(name)) continue;
		c.header(
			'Set-Cookie',
			`${name}=; Domain=${LEGACY_COOKIE_DOMAIN}; Path=/; Max-Age=0; Secure; SameSite=Lax`,
			{ append: true },
		);
	}
});

mountCloudAuth(app, {
	resolveAuthSecrets: (c) => c.env as Cloudflare.Env,
});

// Owner-partitioned reusable surfaces. Each primitive owns its own
// ownership wiring; the deployment passes its auth choice, the rule, and any
// deployment policies.
mountSessionApp(app, { ownership, auth: cookieOrBearer });
// Rooms resolves the bearer itself (WS-aware), so it takes the raw resolver, not
// a prebuilt wrapper.
mountRoomsApp(app, { ownership, resolveUser: resolveRequestOAuthUser });
// Content-addressed blob store (supersedes the retired assets surface). v1 is
// unmetered (no Autumn policy): Autumn's check() denies by default with no plan
// attached, so deferred quota means not calling it. A `syncBlobStorageWithAutumn`
// policy slots in here when storage is billed.
mountBlobsApp(app, { ownership, auth: cookieOrBearer });
mountInferenceApp(app, {
	auth: bearer,
	ownership,
	policies: [chargeOpenAiCreditsWithAutumn],
});
// OpenAI-compatible STT gateway (OpenAI whisper-1, house key). Metered by audio
// duration, settled after the call (per-minute); see chargeOpenAiTranscriptionCredits.
mountTranscriptionApp(app, {
	auth: bearer,
	ownership,
	policies: [chargeOpenAiTranscriptionCredits],
});

// Cloud-only billing data plane. Auth is bundled into the mount so the
// dashboard endpoints can't be mounted without it.
mountBillingApi(app, { auth: cookieOrBearer });

// Dashboard SPA: Workers Static Assets binding serves the SvelteKit
// build. Cloud-only because the `ASSETS` binding lives in this worker's
// wrangler config; self-hosted deployments ship their own UI surface.
app.on(
	'GET',
	['/dashboard', '/dashboard/*'],
	describeRoute({
		description: 'Dashboard SPA static fallback',
		tags: ['dashboard'],
	}),
	async (c) => {
		const assetsFetcher = c.env.ASSETS;
		if (!assetsFetcher) return c.notFound();
		const indexUrl = new URL('/dashboard/index.html', c.req.url);
		return assetsFetcher.fetch(new Request(indexUrl.toString(), c.req.raw));
	},
);

// Legacy redirect: /billing -> /dashboard.
app.get('/billing', (c) => c.redirect('/dashboard'));

// The Worker exposes the Hono fetch handler (the full URL surface above).
// `app.fetch` is bound, so destructuring it is safe.
export default {
	fetch: app.fetch,
};
export { Room };
