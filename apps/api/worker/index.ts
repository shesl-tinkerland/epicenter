/**
 * Epicenter Cloud Worker entry.
 *
 * Composes `@epicenter/server` with the `personal` ownership rule and
 * layers cloud-only billing, admin, and dashboard surfaces on top.
 * Self-hosted team deployments live in a sibling apps/* folder and
 * compose the same library with `team({ isMember })` and no Autumn
 * policies.
 *
 * Read top to bottom for the full URL surface of cloud. Each `mount*`
 * call bundles the auth + ownership + policies + route mount for one
 * reusable surface; the deployment passes only the deployment-controlled
 * knobs (ownership rule, optional cloud policies, auth choice for AI).
 */

import { PRODUCTION_API_URL } from '@epicenter/constants/apps';
import {
	authApp,
	createServerApp,
	mountAiApp,
	mountAssetsApp,
	mountRoomsApp,
	mountSessionApp,
	personal,
	Room,
	requireBearerUser,
	requireCookieOrBearerUser,
} from '@epicenter/server';
import { describeRoute } from 'hono-openapi';
import {
	chargeAiCreditsWithAutumn,
	syncAssetStorageWithAutumn,
} from './billing/policies.js';
import { mountBillingApi } from './billing/routes.js';

const ownership = personal();

// The hosted cloud's public origin never changes per deploy, so it is baked
// from the constants source of truth rather than duplicated into wrangler.jsonc
// vars. Local dev injects `API_PUBLIC_ORIGIN=http://localhost:8787` via
// scripts/dev.ts; production falls through to PRODUCTION_API_URL.
const app = createServerApp({
	resolveOrigin: (env) => env.API_PUBLIC_ORIGIN ?? PRODUCTION_API_URL,
});

// Public health endpoint at root.
app.get('/', (c) =>
	c.json({ mode: 'hub', version: '0.1.0', runtime: 'cloudflare' }),
);

// Auth surface (HTML pages + OAuth metadata; no /api prefix by design,
// no deployment knobs).
app.route('/', authApp);

// Owner-partitioned reusable surfaces. Each primitive owns its own
// auth + ownership wiring; the deployment passes only the rule and any
// deployment policies.
mountSessionApp(app, { ownership });
mountRoomsApp(app, { ownership });
mountAssetsApp(app, {
	ownership,
	policies: [syncAssetStorageWithAutumn],
});
mountAiApp(app, {
	auth: requireBearerUser,
	ownership,
	policies: [chargeAiCreditsWithAutumn],
});

// Cloud-only billing data plane. Auth is bundled into the mount so the
// dashboard endpoints can't be mounted without it.
mountBillingApi(app, { auth: requireCookieOrBearerUser });

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

export default app;
export { Room };
