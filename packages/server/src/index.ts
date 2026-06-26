/**
 * @epicenter/server
 *
 * Shared Hono server for Epicenter cloud and self-hosted shared wiki
 * deployments. Personal mode partitions data by user; shared mode uses
 * one shared owner partition. The full design lives in
 * `specs/20260522T230000-server-package-split.md`.
 *
 * Deployments construct the server app, choose an `OwnershipRule`, then
 * mount each reusable surface with the matching `mount*` primitive. Each
 * primitive owns its auth + ownership wiring; the deployment passes only
 * the rule and any deployment policies (e.g. cloud billing middleware).
 * Sub-apps declare full URLs (including the `/api` prefix where
 * applicable). See `apps/api/worker/index.ts` for the cloud composition.
 */

// Self-host single-user bearer credential source: the `ResolveUser` a
// token-authenticated star injects so a request's `Authorization: Bearer
// <token>` resolves to the box's single owner (ADR-0070, ADR-0071).
export { createInstanceTokenResolver } from './auth/instance-token-resolver.js';
// The OAuth providers a deployment has configured, the SSOT for what auth
// registers and what the self-host entry checks its declared mode against
// (a half-configured pair fails boot; ADR-0072).
export {
	configuredSocialProviders,
	incompleteSocialProviders,
	type OAuthProviderEnv,
} from './auth/social-providers.js';
// Database concern. `createDb(client)` wraps a connected pg client/pool in
// drizzle with the internal schema (the portable core). The Cloudflare
// per-request `pg.Client` over Hyperdrive is now internal to the `cloudflare()`
// runtime adapter (runtime/cloudflare.ts); a Bun host builds its own
// `pg.Pool`-backed adapter inline.
export { createDb, type Db } from './db/create-db.js';
// Deploy-time admin operations (OAuth client seeding) live in each
// deployment's own scripts (`apps/api` `oauth:seed:*`), not in this barrel, so
// `pg` and the drizzle query-builder graph stay out of the worker's module and
// type programs. The seed builds rows from `projectTrustedOAuthClientToRow` in
// `@epicenter/constants/oauth` (beside `buildTrustedOAuthClients`, its input),
// so it never imports this request-path auth barrel.
//
// Auth middleware. `authApp` is mounted directly; the inference surface accepts
// `requireBearerUser` via `mountInferenceApp({ auth })`. Most owner-partitioned
// surfaces wire auth inside their mount primitive and never need these.
export {
	requireBearerUser,
	requireCookieOrBearerUser,
} from './middleware/require-auth.js';
// `doName` builds a room's owner-scoped DO name, deployment-agnostic and
// exported for composing apps. The Cloudflare room registry
// (`createDurableObjectRooms`) is now internal to the `cloudflare()` runtime
// adapter (runtime/cloudflare.ts).
export { doName } from './owner.js';
// Ownership composition: the deployment constructs the rule once via
// `personal()` or `shared({ admit })` and threads it into every mount
// primitive that needs the partition. See ./ownership.ts for the design
// note.
export {
	type Admit,
	type OwnershipRule,
	personal,
	shared,
} from './ownership.js';
// Re-export the Cloudflare Durable Object class so each deployment's
// wrangler.jsonc can resolve `class_name: "Room"` against this entrypoint.
export { Room } from './room/backends/cloudflare/durable-object.js';
// Reusable surfaces. Each `mount*` bundles auth + ownership + the route
// mount, accepting only the deployment-controlled knobs (ownership rule,
// optional policies). The bare `authApp` is mounted directly because it
// has no deployment knobs.
export { authApp } from './routes/auth.js';
export { mountBlobsApp } from './routes/blobs.js';
export { mountInferenceApp } from './routes/inference.js';
export { mountRoomsApp } from './routes/rooms.js';
export { mountSessionApp } from './routes/session.js';
export { bun } from './runtime/bun.js';
// The Cloudflare runtime adapter: the per-runtime triple (db over Hyperdrive,
// `waitUntil`, the Durable Object room registry) as one `RuntimeAdapter` both
// Cloudflare deployables pass to `createServerApp`'s `runtime`. `bun()` is its
// honest peer for a Bun host (same return type; wraps boot-built primitives
// instead of extracting per request). Bun entries usually reach it through the
// `@epicenter/server/bun` barrel.
export { cloudflare } from './runtime/cloudflare.js';
// Parent app. Wires per-request lifecycle (pg, after-response queue,
// auth context, CORS, CSRF, rooms registry). Mount every surface on this
// app via the `mount*` primitives. It takes two axes: a `RuntimeAdapter` (how
// this runtime does the three non-portable jobs) and an `Identity` (who this
// deployment is on the web).
export {
	createServerApp,
	type Identity,
	type RuntimeAdapter,
} from './server-app.js';
// Binding contract: the portable env the library reads from `c.env`, as both
// the arktype schema (value) and its inferred type (same name). Each deployment
// proves its own Env against it (extends in apps/self-host, satisfies in
// apps/api); a Bun host validates `process.env` with the schema at boot.
export { ServerBindings } from './server-bindings.js';
// Public Hono context type the deployment composes around library
// middleware, plus the user-resolution seam a dev entry injects on
// `createServerApp` (default: the real OAuth bearer resolver).
export type { Env, ResolveUser } from './types.js';
