/**
 * Epicenter self-hosted team Worker (reference implementation).
 *
 * Composes `@epicenter/server` with the `team({ isMember })` ownership rule
 * and ships zero billing surface. Workspace data is partitioned under the
 * literal `TEAM_OWNER_ID` ("team"); the membership predicate runs per request
 * against a deployment-owned email allowlist.
 *
 * This is a reference, not an Epicenter-operated product. Copy this folder,
 * fill in the deployment-owned secrets (Better Auth, OAuth provider keys,
 * AI provider keys, `ENCRYPTION_SECRETS`), provision your Cloudflare bindings
 * (Hyperdrive, R2, KV, Durable Objects), and deploy. Community-supported.
 *
 * Trust boundary: `ENCRYPTION_SECRETS` lives in the deployer's environment.
 * Epicenter never sees it, and therefore literally cannot decrypt workspace
 * data hosted on this deployment. Self-hosted is functionally zero-knowledge
 * against Epicenter.
 */

import {
	authApp,
	createServerApp,
	mountAiApp,
	mountAssetsApp,
	mountRoomsApp,
	mountSessionApp,
	Room,
	team,
} from '@epicenter/server';

const ownership = team({
	isMember: (c) => {
		const raw = (c.env.ALLOWED_MEMBER_EMAILS ?? '') as string;
		const allowed = new Set(
			raw
				.split(',')
				.map((s: string) => s.trim())
				.filter(Boolean),
		);
		return allowed.has(c.var.user.email);
	},
});

// Self-hosters set their own public origin in wrangler.jsonc (`API_PUBLIC_ORIGIN`):
// their domain, not Epicenter Cloud's. It is operator config, not a baked
// constant, so it is read straight from `c.env`.
const app = createServerApp({
	resolveOrigin: (env) => env.API_PUBLIC_ORIGIN,
	// A self-host trusts its OWN origin and the Tauri desktop client, never
	// Epicenter cloud's. Add any browser app origins you serve (and the
	// Epicenter browser-extension origin, if your users point it at this
	// deployment) here.
	resolveTrustedOrigins: (_env, baseURL) => [
		new URL(baseURL).origin,
		'tauri://localhost',
	],
	// Single origin: no cross-subdomain cookie domain, so sessions use host-only
	// cookies scoped to this deployment's own host.
});

app.get('/', (c) =>
	c.json({ mode: 'team', version: '0.1.0', runtime: 'cloudflare' }),
);

app.route('/', authApp);

mountSessionApp(app, { ownership });
mountRoomsApp(app, { ownership });
mountAssetsApp(app, { ownership });
mountAiApp(app, { ownership });

export default app;
export { Room };
