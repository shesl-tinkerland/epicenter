/**
 * `startBunServer` — the shared Bun process bootstrap (ADR-0066).
 *
 * The two Bun deployables (`apps/api/server.ts`, `apps/self-host/server.ts`)
 * differ only in their ownership rule, trusted origins, default port, health
 * `mode`, and one optional extra mount. Everything mechanical (the `pg.Pool`,
 * the `bun:sqlite` room registry, the `bun()` adapter, `createServerApp`, the
 * shared `authApp` + session + rooms + inference mounts, and `Bun.serve` +
 * `bindServer`) is identical, so it lives here once and the entries supply only
 * the per-deployment composition.
 *
 * This module is the Bun surface and is never in the Worker bundle: it imports
 * `pg`, `createBunRooms` (`bun:sqlite`), and `Bun.serve` directly. It is
 * reached through the `@epicenter/server/bun` barrel.
 *
 * Env validation stays in each entry, not here: the entry owns its own env
 * contract (it may carry extra fields like `ALLOWED_MEMBER_EMAILS`) and its own
 * error label, validates `process.env` against {@link BunHostBindings} (merging
 * its extras), and hands the validated value in. The boot banner likewise stays
 * in the entry (an app may log; library code may not), which is why this returns
 * the resolved `origin` and `dataDir` instead of logging them.
 */

import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Hono } from 'hono';
import pg from 'pg';
import { createDb } from './db/create-db.js';
import { requireBearerUser } from './middleware/require-auth.js';
import type { OwnershipRule } from './ownership.js';
import { createBunRooms } from './room/backends/bun/registry.js';
import { authApp } from './routes/auth.js';
import { mountInferenceApp } from './routes/inference.js';
import { mountRoomsApp } from './routes/rooms.js';
import { mountSessionApp } from './routes/session.js';
import { bun } from './runtime/bun.js';
import { createServerApp, type Identity } from './server-app.js';
import { ServerBindings } from './server-bindings.js';
import type { Env, ResolveUser } from './types.js';

/**
 * The shared Bun-host env contract: the portable {@link ServerBindings} plus the
 * process-level config every Bun entry reads. An entry validates `process.env`
 * against this (merging its own extras) and hands the validated value to
 * {@link startBunServer}. `DATABASE_URL` is the one required addition; the rest
 * default in `startBunServer`.
 */
export const BunHostBindings = ServerBindings.merge({
	DATABASE_URL: 'string',
	'PORT?': 'string',
	'API_PUBLIC_ORIGIN?': 'string',
	'DATA_DIR?': 'string',
});
export type BunHostBindings = typeof BunHostBindings.infer;

/**
 * Resolve the single data dir a Bun host persists under. The room `bun:sqlite`
 * files AND the self-host instance token both live here, so they share fate: a
 * persisted `DATA_DIR` keeps both, an ephemeral one loses both, never one
 * without the other. One default, one resolver, called by both `startBunServer`
 * (rooms) and the self-host entry (the token mint), so the two can never
 * diverge onto separate directories (the prior `'.'`-vs-`'./.data/rooms'` split
 * silently stranded the token in the cwd while the rooms persisted elsewhere).
 */
export function resolveDataDir(env: { DATA_DIR?: string }): string {
	return resolve(env.DATA_DIR ?? './.data/rooms');
}

export type StartBunServerOptions = {
	/**
	 * The validated env. Assignable to {@link BunHostBindings}: a deployment may
	 * carry extra fields (e.g. `ALLOWED_MEMBER_EMAILS`) it read in its own scope
	 * before building `ownership`.
	 */
	env: BunHostBindings;
	/** Port to listen on when `env.PORT` is unset (apps/api 8788, self-host 8787). */
	defaultPort: number;
	/** The `mode` string the health endpoint returns at `/` (`hub` | `shared`). */
	mode: string;
	/**
	 * This deployment's partition rule, built by the caller from its own typed
	 * env (self-host parses the member allowlist before constructing `shared`).
	 */
	ownership: OwnershipRule;
	/** The origins this deployment trusts (CORS, cookie-CSRF, Better Auth redirects). */
	resolveTrustedOrigins: Identity['resolveTrustedOrigins'];
	/** Registrable cookie domain, when this deployment spans subdomains. */
	cookieDomain?: string;
	/**
	 * Extra sub-apps beyond the shared session/rooms/inference surface (apps/api
	 * adds `mountBlobsApp`; self-host adds none).
	 */
	mountExtras?: (app: Hono<Env>, ownership: OwnershipRule) => void;
	/**
	 * Dev-only user resolver the dev entry injects to drive the parity smoke
	 * without an interactive login. Production omits it and keeps the real OAuth
	 * resolver.
	 */
	resolveUser?: ResolveUser;
};

/**
 * Boot a Bun-hosted Epicenter server: validate-free (the entry validated `env`),
 * build the runtime, mount the shared surface plus any extras, and listen.
 * Returns the resolved `origin` and room `dataDir` so the entry can log its own
 * boot banner.
 */
export function startBunServer({
	env,
	defaultPort,
	mode,
	ownership,
	resolveTrustedOrigins,
	cookieDomain,
	mountExtras,
	resolveUser,
}: StartBunServerOptions): { origin: string; dataDir: string } {
	const port = Number(env.PORT ?? defaultPort);
	// The auth origin must match where the process actually listens (cookies, the
	// OAuth issuer, the token audience all derive from it). Default to localhost
	// on the chosen port; an operator overrides it with their domain.
	const origin = env.API_PUBLIC_ORIGIN ?? `http://localhost:${port}`;

	// One room directory of `bun:sqlite` files for this host (the self-host
	// entry mints its instance token into this same resolved dir).
	const dataDir = resolveDataDir(env);
	mkdirSync(dataDir, { recursive: true });
	const bunRooms = createBunRooms({ dir: dataDir });

	// One pool for the process; drizzle checks a client out per query and returns
	// it, so `bun()`'s `connectDb` hands back the shared handle with a no-op close.
	const pool = new pg.Pool({ connectionString: env.DATABASE_URL });
	const db = createDb(pool);

	const app = createServerApp({
		runtime: bun({ db, rooms: bunRooms.rooms }),
		identity: {
			resolveOrigin: () => origin,
			resolveTrustedOrigins,
			cookieDomain,
		},
		// Undefined in production: `createServerApp` falls back to the real OAuth
		// resolver. A dev entry passes a dev bearer resolver.
		resolveUser,
	});

	app.get('/', (c) => c.json({ mode, version: '0.1.0', runtime: 'bun' }));
	app.route('/', authApp);
	mountSessionApp(app, { ownership });
	mountRoomsApp(app, { ownership });
	mountInferenceApp(app, { auth: requireBearerUser, ownership });
	mountExtras?.(app, ownership);

	const server = Bun.serve({
		port,
		// Bun calls `fetch(req, server)`; route everything through the Hono app
		// with the validated env as `c.env`. WebSocket upgrades happen inside the
		// rooms route via the bound server (see createBunRooms), after auth runs,
		// so they are never intercepted ahead of the auth pipeline here.
		fetch: (req) => app.fetch(req, env),
		websocket: bunRooms.websocket,
	});
	// `server` only exists once `Bun.serve` returns; hand it to the room registry
	// so `handleUpgrade` can call `server.upgrade`.
	bunRooms.bindServer(server);

	return { origin, dataDir };
}
