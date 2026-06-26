/**
 * Bun entry for apps/api: the runtime port's keystone second runtime.
 *
 * Builds the SAME `createServerApp(...)` the Cloudflare Worker builds
 * (`worker/index.ts`), but binds the per-concern runtime hooks to plain
 * primitives instead of Cloudflare bindings (ADR-0066):
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

import {
	BunHostBindings,
	mountBlobsApp,
	personal,
	type ResolveUser,
	startBunServer,
} from '@epicenter/server/bun';
import { type } from 'arktype';
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
	// Validate this Bun host's environment once, at boot: the library's portable
	// secrets (`BunHostBindings` extends `ServerBindings`) and this host's own
	// config, so a misconfiguration gets ONE descriptive error naming every
	// missing or malformed var instead of a downstream surprise. The validated
	// result IS the typed env handed to the Hono app: no `as`-cast over
	// `process.env`, no lie (ADR-0066). Unlike the Cloudflare edge (whose bindings
	// are deploy-gated and `wrangler types`-typed), `process.env` is unchecked, so
	// boot is the place to validate it.
	// The portable contract leaves the OAuth providers optional (a solo self-host
	// box configures none; ADR-0071). The hosted star is never provider-less, so
	// re-require Google here: forgetting the deploy secret should fail boot loud,
	// not silently drop Google sign-in.
	const env = BunHostBindings.merge({
		GOOGLE_CLIENT_ID: 'string',
		GOOGLE_CLIENT_SECRET: 'string',
	})(process.env);
	if (env instanceof type.errors) {
		console.error(`Invalid environment for the Bun server:\n${env.summary}`);
		process.exit(1);
	}

	// apps/api partitions per user (`personal()`) and adds the content-addressed
	// blob store; everything else is the shared Bun bootstrap.
	const { origin, dataDir } = startBunServer({
		env,
		defaultPort: 8788,
		mode: 'hub',
		ownership: personal(),
		resolveTrustedOrigins: buildEpicenterTrustedOrigins,
		mountExtras: (app, ownership) => mountBlobsApp(app, { ownership }),
		// Undefined in production; `server.dev.ts` passes a dev bearer resolver.
		resolveUser: opts.resolveUser,
	});

	console.log(`apps/api (Bun) listening on ${origin} (rooms in ${dataDir})`);
}

// Run production only when this file is the entrypoint. `server.dev.ts` imports
// `startBunApiServer` to boot the dev variant, and must not trigger a second
// listener here.
if (import.meta.main) startBunApiServer();
