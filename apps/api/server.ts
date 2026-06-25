/**
 * Bun entry for apps/api: the runtime port's keystone second runtime.
 *
 * Builds the SAME `createServerApp(...)` the Cloudflare Worker builds
 * (`worker/index.ts`), but binds the per-concern runtime hooks to plain
 * primitives instead of Cloudflare bindings (ADR-0059):
 *
 *   - `connectDb`     a module-scope `pg.Pool` over `DATABASE_URL`
 *   - `afterResponse` fire-and-forget in the live process (no `waitUntil`)
 *   - `resolveRooms`  an in-process registry over `bun:sqlite` files
 *   - blobs           any S3 endpoint via the existing `BLOBS_S3_*` env
 *
 * This is additive: `wrangler dev`/`deploy` still serve the Worker unchanged.
 * `bun --watch server.ts` boots instantly with real stack traces, and the same
 * entry is the "one binary + Postgres + S3, no Cloudflare account" self-host
 * artifact (and what a Tauri shell embeds locally).
 *
 * The wiring lives in {@link startBunApiServer} so `server.dev.ts` can boot the
 * SAME server with a dev `resolveUser` injected (the parity smoke's credential)
 * without duplicating it. The bottom of this file runs production only when this
 * file IS the entrypoint (`import.meta.main`), so `server.dev.ts` importing the
 * builder does not also start a second listener. Production passes no
 * `resolveUser` and keeps the real OAuth resolver; this file never imports the
 * dev bypass.
 *
 * Runtime skew is fenced by design: a DO-only behavior (hibernation restore,
 * alarm timing, edge placement) will not surface here, so `wrangler dev` /
 * staging stays the fidelity gate before any deploy touching room behavior.
 *
 * The dashboard SPA and billing data plane are intentionally omitted: Vite
 * serves the dashboard in dev, and billing is the hosted Worker's concern.
 */

import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import {
	authApp,
	createBunRooms,
	createDb,
	createServerApp,
	mountBlobsApp,
	mountInferenceApp,
	mountRoomsApp,
	mountSessionApp,
	personal,
	type ResolveUser,
	requireBearerUser,
	ServerBindings,
} from '@epicenter/server/bun';
import { type } from 'arktype';
import pg from 'pg';
import { buildEpicenterTrustedOrigins } from './worker/trusted-origins.js';

/**
 * Boot the apps/api Bun server, optionally with an injected user resolver.
 *
 * Production (`server.ts` as the entrypoint) passes nothing, so
 * `createServerApp` keeps the real OAuth resolver. `server.dev.ts` passes a
 * dev `Bearer dev:<userId>` resolver so the parity smoke needs no interactive
 * login. Everything else (env validation, pool, rooms, mounts, `Bun.serve`) is
 * identical across the two, so they cannot drift.
 */
export function startBunApiServer(
	opts: { resolveUser?: ResolveUser } = {},
): void {
	// Validate the whole environment once, at boot. The library's portable
	// secrets (the `ServerBindings` schema) and this Bun host's own config are
	// checked together, so a misconfigured self-host gets ONE descriptive error
	// naming every missing or malformed var instead of a downstream surprise. The
	// validated result IS the typed env handed to the Hono app: no `as`-cast over
	// `process.env`, no lie (ADR-0059). Unlike the Cloudflare edge (whose bindings
	// are deploy-gated and `wrangler types`-typed), `process.env` is unchecked, so
	// boot is the place to validate it.
	const env = ServerBindings.merge({
		// This Bun host's own config (not library bindings): the Postgres URL is
		// required; the rest have safe defaults applied below.
		DATABASE_URL: 'string',
		'PORT?': 'string',
		'API_PUBLIC_ORIGIN?': 'string',
		'DATA_DIR?': 'string',
	})(process.env);
	if (env instanceof type.errors) {
		console.error(`Invalid environment for the Bun server:\n${env.summary}`);
		process.exit(1);
	}

	const port = Number(env.PORT ?? 8788);
	// The auth origin must match where the process actually listens (cookies, the
	// OAuth issuer, the token audience all derive from it). Default to localhost
	// on the chosen port; an operator overrides it with their domain.
	const origin = env.API_PUBLIC_ORIGIN ?? `http://localhost:${port}`;

	// One room directory of `bun:sqlite` files for this host.
	const dataDir = resolve(env.DATA_DIR ?? './.data/rooms');
	mkdirSync(dataDir, { recursive: true });
	const bunRooms = createBunRooms({ dir: dataDir });

	// One pool for the process; drizzle checks a client out per query and returns
	// it, so `connectDb` hands back the shared handle with a no-op close.
	const pool = new pg.Pool({ connectionString: env.DATABASE_URL });
	const db = createDb(pool);

	const ownership = personal();

	const app = createServerApp({
		// The Bun runtime adapter, built inline: a shared `pg.Pool` checkout with a
		// no-op close, a no-op `afterResponse`, and the in-process room registry.
		// There is no `bun()` factory mirroring `cloudflare()`: that triple is
		// verbatim across the two Cloudflare deployables, but this one has a single
		// producer, so it stays inline where the entry can read it.
		runtime: {
			connectDb: async () => ({ db, close: async () => {} }),
			// No-op: the drain promise (server-app.ts awaits the after-response
			// queue, then closes the per-request handle) is already running when it
			// reaches here, and a long-lived Bun process needs no `waitUntil` to
			// outlive the response. Cloudflare's adapter instead hands it to
			// `executionCtx.waitUntil`.
			afterResponse: () => {},
			resolveRooms: () => bunRooms.rooms,
		},
		identity: {
			resolveOrigin: () => origin,
			resolveTrustedOrigins: buildEpicenterTrustedOrigins,
		},
		// Undefined in production: `createServerApp` falls back to the real OAuth
		// resolver. `server.dev.ts` passes a dev bearer resolver.
		resolveUser: opts.resolveUser,
	});

	app.get('/', (c) =>
		c.json({ mode: 'hub', version: '0.1.0', runtime: 'bun' }),
	);
	app.route('/', authApp);
	mountSessionApp(app, { ownership });
	mountRoomsApp(app, { ownership });
	mountBlobsApp(app, { ownership });
	mountInferenceApp(app, { auth: requireBearerUser, ownership });

	const server = Bun.serve({
		port,
		// Bun calls `fetch(req, server)`; we route everything through the Hono app
		// with the validated env as `c.env`. WebSocket upgrades are performed inside
		// the rooms route via the bound server (see createBunRooms), after auth
		// runs, so they are never intercepted ahead of the auth pipeline here.
		fetch: (req) => app.fetch(req, env),
		websocket: bunRooms.websocket,
	});
	// `server` only exists once `Bun.serve` returns; hand it to the room registry
	// so `handleUpgrade` can call `server.upgrade`.
	bunRooms.bindServer(server);

	console.log(`apps/api (Bun) listening on ${origin} (rooms in ${dataDir})`);
}

// Run production only when this file is the entrypoint. `server.dev.ts` imports
// `startBunApiServer` to boot the dev variant, and must not trigger a second
// listener here.
if (import.meta.main) startBunApiServer();
