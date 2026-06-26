# apps/self-host

Reference self-host deployable (community-supported, not Epicenter-operated). Two runtimes off one `@epicenter/server` composition: a Cloudflare Worker shared wiki (`worker/index.ts`, `shared({ admit })`) and an off-Cloudflare Bun entry (`server.ts`) that runs solo (`personal()` + a first-boot bearer) or shared, picked by an explicit `EPICENTER_MODE` (default `solo`) whose value the configured OAuth providers must agree with at boot (ADR-0072).

Operator-facing docs for both runtimes live in `README.md`. Keep the worker entry small (~30 lines) so it stays readable as a reference.

## Hard constraints

- Do not import `@epicenter/billing` (it no longer exists; billing lives inside `apps/api/worker/billing/` and is hosted-only).
- Do not add `autumn-js`, `AUTUMN_SECRET_KEY`, or `/api/billing/*` routes.
- Do not add a dashboard SPA or Workers Static Assets binding.
- Do not collapse `SHARED_OWNER_ID` into env config: it is byte-pinned durable data (R2 prefix, DO name prefix, IDB prefix).

## When editing

- Changes to composition primitives (`mount*`, `shared()`, `personal()`) live in `packages/server`, not here.
- Updates to the deployment trust model live in `docs/trust-model.md` and `apps/api/README.md`.
- For deployment configuration, treat the wrangler bindings as user-customized; do not commit a working set of bindings.
