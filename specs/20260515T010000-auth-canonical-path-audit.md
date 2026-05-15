# Auth, Workspace Session, Local Unlock, And Transport Canonical Path

**Date**: 2026-05-15
**Status**: Recommendation
**Author**: AI-assisted

## One Sentence

Epicenter uses Better Auth as the OAuth server, stores one client-side `PersistedAuth` cell with an online grant and local unlock bundle, mounts workspaces while local unlock exists, and routes all network access through auth-owned HTTP and WebSocket transports.

This is the final recommendation for the current architecture pass. It replaces the older `OAuthSession`, `WorkspaceIdentityStore`, id-token-carried keys, raw token getter, and device-authorization directions.

## Recommendation

Keep the landed `{ grant, unlock }` architecture and harden it. Do not split identity into a second workspace store, do not move encryption keys into `id_token`, do not reintroduce raw token getters, and do not revive Better Auth device authorization for the CLI.

The smallest coherent final shape is:

```txt
Better Auth
  owns account sessions, login pages, OAuth consent, authorization code,
  refresh token, revoke, JWKS, and trusted client metadata

Epicenter API
  owns /api/me and protected-resource authorization

@epicenter/auth
  owns PersistedAuth, refresh, revoke, /api/me verification,
  auth.fetch, and auth.openWebSocket

@epicenter/svelte
  owns workspace session mounting from auth.state

@epicenter/workspace
  owns LocalOwner, local Yjs persistence, encryption attachment,
  BroadcastChannel scoping, sync, and wipe
```

The durable cell stays exactly this shape:

```ts
type PersistedAuth = {
  grant: {
    accessToken: string;
    refreshToken: string;
    accessTokenExpiresAt: number;
  };
  unlock: {
    userId: string;
    encryptionKeys: EncryptionKeys;
  };
};
```

The public auth state stays capability-only:

```ts
type AuthState =
  | { status: 'signed-out' }
  | { status: 'signed-in'; unlock: LocalUnlockBundle }
  | { status: 'reauth-required'; unlock: LocalUnlockBundle };
```

Profile fields are application data. Email, display name, avatar, billing plan, and org membership are fetched by the surfaces that display them. Auth state does not carry them.

## Checkpoint Evidence

### Checkpoint 1: Current Architecture And Invariants

Current code already implements the core split:

| Concern | Current owner | Evidence |
| --- | --- | --- |
| Durable auth shape | `@epicenter/auth` | `packages/auth/src/auth-types.ts` defines `OAuthTokenGrant`, `LocalUnlockBundle`, and `PersistedAuth`. |
| Auth state | `@epicenter/auth` | `packages/auth/src/auth-contract.ts` defines three states; both identity-bearing states carry `unlock`. |
| Network gate | `@epicenter/auth` | `packages/auth/src/create-oauth-app-auth.ts` refreshes, calls `/api/me`, and only then attaches bearer credentials. |
| Svelte reactivity | `@epicenter/auth-svelte` | `packages/auth-svelte/src/create-auth.svelte.ts` wraps core state with `createSubscriber`. |
| Workspace lifetime | `@epicenter/svelte` | `packages/svelte-utils/src/session.svelte.ts` keeps payload mounted for `signed-in` and `reauth-required`, and disposes only on `signed-out`. |
| Local owner | `@epicenter/workspace` | `packages/workspace/src/document/local-owner.ts` scopes IDB, BroadcastChannel, encryption, and wipe by `userId`. |
| API identity | `apps/api` | `apps/api/src/app.ts` mounts `/api/me`; `apps/api/src/auth/resource-boundary.ts` verifies bearer token, issuer, audience, scope, and user existence. |
| Credential normalization | `apps/api` | `apps/api/src/auth/single-credential.ts` rejects cookie plus bearer ambiguity and lifts WebSocket bearer subprotocol into `Authorization`. |

Durable rules:

1. Raw OAuth tokens stay inside auth storage and auth transport.
2. `auth.fetch` and `auth.openWebSocket` are the app transport capabilities.
3. `/api/me` is the only client identity projection: verified bearer token plus Better Auth user plus derived encryption keys.
4. Local decrypt can continue when network auth is paused.
5. Browser-local Yjs data is scoped by `(userId, ydoc.guid)`.
6. `reauth-required` is identity-bearing, not signed out.
7. Sign-out clears the auth cell but does not wipe Yjs data unless the user takes a separate destructive action.

### Checkpoint 2: Candidate Boundaries

Four boundaries were compared.

| Candidate | Shape | Result |
| --- | --- | --- |
| A. Bundled session | `OAuthSession = tokens + user + encryptionKeys` | Reject. It couples token rotation to local identity and profile data. It already lost to `PersistedAuth`. |
| B. Separate workspace identity store | Auth stores tokens; workspace stores identity and keys | Reject. It adds a second lifecycle and same-user guard with no live consumer that needs independent storage. |
| C. id_token carries encryption keys | OAuth token response becomes identity source | Reject. Encryption keys are capability material, not profile claims. Loggers and libraries treat id tokens as identity objects. |
| D. One persisted cell with grant and unlock | Auth stores `{ grant, unlock }`; `/api/me` verifies and refreshes unlock | Choose. It matches the current implementation, keeps offline unlock available, and keeps network credentials behind auth transport. |

Candidate D is the smallest shape that explains every runtime:

```txt
Browser redirect OAuth
Extension WebAuthFlow OAuth
Machine OOB OAuth
  -> OAuthTokenGrant
  -> /api/me
  -> PersistedAuth
  -> AuthState
  -> createSession
  -> LocalOwner
  -> auth.fetch and auth.openWebSocket
```

### Checkpoint 3: Final Boundary

The final boundary is not "auth owns identity." That sentence is too broad.

The final boundary is:

```txt
auth owns capabilities:
  online grant
  local unlock
  transport

workspace owns local data:
  Y.Doc
  local persistence
  encryption attachment
  sync attachment

application owns profile:
  email
  avatar
  billing display
  account labels
```

This keeps the product sentence compact:

```txt
Sign in once, unlock local encrypted workspaces offline, and use the server only through auth-owned transports when online.
```

### Checkpoint 4: Spec Output

This file is the canonical architecture spec. Implementation agents should read it before changing auth, workspace session, local unlock, or network transport code.

## Runtime Paths

There are three launch paths and one shared runtime.

```txt
Browser app
  launcher: browser redirect
  storage: app localStorage
  callback: app /auth/callback

Extension
  launcher: browser.identity.launchWebAuthFlow
  storage: chrome.storage.local
  callback: browser extension redirect URL

Machine
  launcher: OOB code paste
  storage: ~/.epicenter/auth.json with 0600 mode
  callback: hosted /auth/cli-callback page
```

After launch, all three converge:

```txt
grant from /auth/oauth2/token
  -> GET /api/me with Authorization: Bearer
  -> write PersistedAuth
  -> expose AuthState
  -> build workspace session from unlock
  -> call protected resources through auth.fetch or auth.openWebSocket
```

Daemon is not a fourth auth path. Daemons load the machine cell and construct `createOAuthAppAuth` with a noninteractive launcher.

## Ownership

| Surface | Owner | Must not know |
| --- | --- | --- |
| OAuth provider routes | Better Auth inside `apps/api` | Workspace storage names, Yjs, local unlock UI. |
| `/api/me` | Epicenter API | Browser storage adapters, Svelte session lifecycle. |
| `PersistedAuth` | `@epicenter/auth` | App profile display, workspace tables. |
| `auth.fetch` | `@epicenter/auth` | Resource-specific retry policy beyond one auth retry. |
| `auth.openWebSocket` | `@epicenter/auth` | Sync protocol details beyond subprotocol insertion. |
| `createSession` | `@epicenter/svelte` | Raw OAuth tokens, profile fields. |
| `LocalOwner` | `@epicenter/workspace` | Refresh tokens, account profile, hosted sign-in. |
| `openCollaboration` and sync | `@epicenter/workspace` | Token storage, `/api/me`, Better Auth cookies. |
| Account popover and billing UI | Application or shared UI | Refresh tokens, local encryption key derivation. |

## Storage Shape

Browser and extension storage should validate exactly `PersistedAuth | null`.

Machine storage should validate exactly the same shape, with file permissions enforced before parsing. Keep the filename `~/.epicenter/auth.json` unless a product decision introduces multiple accounts or multiple server profiles.

Do not add:

```txt
OAuthSession
AuthIdentity
WorkspaceIdentityStore
profile bucket
token getter cache
idToken identity cache
```

Old storage keys are intentionally ignored. Compatibility would create a second session model and make local unlock semantics harder to prove.

## State Machines

### Auth Client

```txt
signed-out
  persisted = null
  workspace session = null
  auth.fetch sends no bearer
  auth.openWebSocket sends no bearer

signed-in
  persisted exists
  unlock is readable
  bearer may be attached only after /api/me verifies current cell

reauth-required
  persisted exists
  unlock is readable
  network auth is paused
  workspace session stays mounted
```

Transitions:

```txt
startSignIn succeeds
  grant -> /api/me -> write PersistedAuth -> signed-in

cold boot with cell
  signed-in immediately for local unlock
  first network call refreshes if stale, then verifies /api/me

refresh succeeds
  write grant only
  clear network verification
  verify /api/me before next bearer-bearing call

refresh fails
  keep unlock
  state = reauth-required

/api/me same-user guard fails
  clear cell
  state = signed-out

signOut
  clear cell
  state = signed-out
  revoke refresh token best effort unless a later migration strengthens it
```

### Workspace Session

```txt
auth signed-out
  dispose payload
  current = null

auth signed-in or reauth-required
  if no payload:
    build LocalOwner from unlock.userId and lazy encryptionKeys()
  if payload exists:
    keep it mounted
```

The migration must harden the same-user assumption. Today, `createSession` keeps payload when any identity-bearing state follows another. That is coherent only if auth guarantees no same-runtime different-user transition without `signed-out` in between. Make that invariant explicit in tests.

### Local Owner

```txt
owner.userId
  -> createOwnedYjsKey(userId, ydoc.guid)
  -> encrypted IndexedDB database name
  -> BroadcastChannel key
  -> wipe prefix

owner.encryptionKeys()
  -> lazy read from current auth.state.unlock
  -> lets /api/me key rotation take effect without rebuilding workspace
```

Local owner is a browser concept. Daemons attach encryption directly and persist by filesystem.

### Network Transport

```txt
auth.fetch(request)
  -> refresh grant if near expiry
  -> verify current cell with /api/me if needed
  -> attach Authorization: Bearer
  -> credentials: omit
  -> one forced refresh and retry on 401

auth.openWebSocket(url, protocols)
  -> refresh grant if near expiry
  -> verify current cell with /api/me if needed
  -> append bearer.<accessToken> subprotocol
```

Server middleware converts a WebSocket bearer subprotocol into `Authorization` before protected resource middleware runs. Resource routes then verify the token with Better Auth's OAuth resource client.

## Race Handling

These are first-wave hardening items before new architecture work.

| Risk | Current evidence | Required checkpoint |
| --- | --- | --- |
| Refresh writes stale grant after sign-out | `refreshGrant` writes storage before the stale check after `set` returns. | Re-check `persisted === startedFrom` before and after storage writes, or make storage writes compare-and-swap. Add a regression test. |
| `/api/me` key update writes stale unlock after sign-out | `verifyIdentity` writes updated keys before the stale check after `set` returns. | Same stale-write test pattern for key update. |
| Identity-bearing user changes without signed-out gap | `createSession` keeps existing payload whenever payload exists. | Either enforce signed-out gap in auth or compare `unlock.userId` in `createSession` and rebuild on change. |
| WebSocket without bearer after verification failure | `openWebSocket` can construct without bearer when `bearerForNetwork` returns null. | For protected sync URLs, return a failed promise or close early instead of opening anonymous. Decide in the sync transport migration. |
| Fetch retry with non-replayable body | `auth.fetch` retries once after 401. | Document caller constraint and add a test for `Request` clone behavior. Do not hide arbitrary stream replay. |
| Machine OOB state verification | OOB launcher generates state; current paste flow does not verify it from user input. | Render a copyable `{ code, state }` payload or remove state and comments claiming local verification. |
| Machine temp-file collision | Machine store uses a fixed temp path. | Use a random or process-specific temp path before claiming concurrent login or refresh safety. |

## External Precedents

| Precedent | What it shows | Consequence for Epicenter |
| --- | --- | --- |
| [Better Auth OAuth Provider](https://better-auth.com/docs/plugins/oauth-provider) | OAuth provider owns authorization code, refresh token, revocation, trusted clients, public clients, JWT and JWKS behavior, and resource verification helpers. | Keep Better Auth as the auth server. Do not build OAuth by hand. |
| [Better Auth resource client](https://better-auth.com/docs/plugins/oauth-provider) | API servers verify `Authorization: Bearer` tokens with issuer, audience, expiration, signature or introspection, and scope checks. | Keep `/api/me` and protected resources behind server-side token verification. |
| [Cloudflare Durable Object WebSockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/) | Durable Objects are the right coordination point for long-lived WebSocket sessions. Hibernation resets memory and requires durable or attached state. | Keep Room DOs as room coordinators; do not put auth session truth in DO memory. |
| [Hono middleware](https://hono.dev/docs/guides/middleware) | Middleware runs in registration order. | Keep `singleCredential` before protected resources and OAuth discovery before `/auth/*` catch-all routes. |
| [Yjs document updates](https://docs.yjs.dev/api/document-updates) | Updates are commutative, associative, idempotent binary deltas. | Sync should move bytes and presence, not profile or auth state. |
| [y-protocols awareness](https://docs.yjs.dev/api/about-awareness) | Awareness is network-agnostic presence and schemaless local state, usually implemented by providers. | Treat awareness `replica` as client-claimed presence, not verified account identity. Server-stamped `subject` belongs outside awareness. |
| [y-indexeddb](https://docs.yjs.dev/ecosystem/database-provider/y-indexeddb) | `docName` is the durable browser database identity and enables offline editing. | Use owner-scoped database names for authenticated browser workspaces. |
| [Svelte createSubscriber](https://svelte.dev/docs/svelte/svelte-reactivity) | External event sources can be reflected into reactive reads. | Keep `auth-svelte` as a thin reactive wrapper over framework-agnostic auth. |
| [SvelteKit load](https://svelte.dev/docs/kit/load) | Universal load runs in both server and browser; server load has request-only data. | Keep raw OAuth tokens out of universal app code. Use client auth transport for browser-only resource calls. |
| [Tauri opener](https://tauri.app/reference/javascript/opener/) | Opening URLs is an explicit platform capability with URL scope configuration. | Browser-launch auth belongs in launchers, not in core auth state. |
| [WXT storage](https://wxt.dev/storage) | Extension storage is key-based and async, with `local`, `session`, and metadata APIs. | Extension storage is a runtime adapter for the same `PersistedAuth` shape, not a different auth model. |
| [Drizzle Turso docs](https://orm.drizzle.team/docs/connect-turso) | Drizzle supports runtime-specific database drivers and serverless databases. | Keep database concerns in API composition. Auth clients should not learn DB adapter shapes. |
| [Cloudflare Workers Turso tutorial](https://developers.cloudflare.com/workers/tutorials/connect-to-turso-using-workers/) | Worker database connections are runtime concerns. | Per-request DB setup stays server-side. |
| [TanStack AI provider tools](https://tanstack.com/ai/latest/docs/tools/provider-tools) | Provider-specific capabilities are branded and gated at the adapter boundary. | Mirror this: expose `auth.fetch` and `auth.openWebSocket` capabilities, not raw token data. |
| `~/Code/ai` provider source | `/Users/braden/Code/ai/packages/openai/src/openai-provider.ts` hides API-key header construction inside provider instances. | Capability-owned transport is a local precedent, not just an auth preference. |
| `~/Code/ai` UI source | `/Users/braden/Code/ai/packages/react/src/use-chat.ts` exposes state and actions, not the provider key. | UI surfaces should consume actions and state, not secrets. |
| [jsrepo registry](https://jsrepo.dev/docs/registry) | Registry blocks are installed as local source with explicit manifests. | Installed app or component templates should depend on public capabilities, not hidden host auth internals. |
| [libsignal Sesame](https://signal.org/docs/specifications/sesame/) | Devices store identity and session state locally; servers are not the source of encrypted-session secrets. | Local unlock belongs to the client capability layer, while server auth verifies account access. |
| [Bitwarden log in vs unlock](https://bitwarden.com/help/understand-log-in-vs-unlock/) | Login requires server access; unlock works against already stored encrypted local data. | `reauth-required` must not unmount local encrypted workspaces. |
| [shadcn-svelte installation](https://www.shadcn-svelte.com/docs/installation) | Components are copied into local projects and imported through local files. | UI components should receive auth/profile data as props or queries, not import auth internals. |
| [shadcn-svelte-extras](https://www.shadcn-svelte-extras.com/docs/introduction) | Extras emphasize composability and do not force defaults that belong to the host app. | Shared UI should stay composable around auth state and profile queries. |
| [TanStack Table Svelte state](https://tanstack.com/table/latest/docs/framework/svelte/guide/table-state) | Control only the state you need; leave the rest internal. | Auth state should expose only capability state. Profile freshness and UI labels should stay outside. |
| [Autumn usage tracking](https://docs.useautumn.com/documentation/customers/tracking-usage) | Billing tracks usage against a customer id after the customer exists. | Billing depends on verified user id at protected API routes, not profile data in auth state. |

## Call Sites To Preserve

Browser auth clients:

```txt
apps/dashboard/src/lib/platform/auth/auth.ts
apps/opensidian/src/lib/platform/auth/auth.ts
apps/fuji/src/lib/platform/auth/auth.ts
apps/honeycrisp/src/lib/platform/auth/auth.ts
apps/zhongwen/src/lib/platform/auth/auth.ts
apps/tab-manager/src/lib/platform/auth/auth.ts
```

Workspace session builders:

```txt
apps/opensidian/src/lib/session.ts
apps/fuji/src/lib/session.ts
apps/honeycrisp/src/lib/session.ts
apps/zhongwen/src/lib/session.ts
apps/tab-manager/src/lib/session.svelte.ts
```

Transport consumers:

```txt
apps/opensidian/src/lib/opensidian/browser.ts
apps/fuji/src/routes/(signed-in)/fuji/browser.ts
apps/honeycrisp/src/routes/(signed-in)/honeycrisp/browser.ts
apps/tab-manager/src/lib/tab-manager/extension.ts
apps/*/blocks/daemon-route.ts
packages/workspace/src/document/open-collaboration.ts
packages/workspace/src/document/internal/sync-supervisor.ts
```

Server gates:

```txt
apps/api/src/app.ts
apps/api/src/auth/create-auth.ts
apps/api/src/auth/resource-boundary.ts
apps/api/src/auth/single-credential.ts
apps/api/src/auth/trusted-oauth-clients.ts
```

## Migration Checkpoints

### Phase 1: Prove Existing Invariants

- [ ] Add auth tests for stale refresh write after sign-out.
- [ ] Add auth tests for stale `/api/me` key-update write after sign-out.
- [ ] Add a session test for same-user identity-bearing transitions.
- [ ] Add or update a test proving `reauth-required` keeps the workspace mounted.
- [ ] Add a transport test proving protected sync does not open an anonymous WebSocket when auth verification fails.

### Phase 2: Harden Auth Core

- [ ] Fix stale storage writes in refresh and `/api/me` verification.
- [ ] Decide whether `AuthClient.signOut()` should await revoke in machine contexts or stay best effort everywhere.
- [ ] Share the OAuth token response parser across browser, extension, refresh, and OOB launchers.
- [ ] Import the bearer subprotocol prefix from `@epicenter/sync` or move it to a shared no-cycle package.

### Phase 3: Harden Machine OOB

- [ ] Fix OOB state semantics by copying `{ code, state }`, or remove the local state check language.
- [ ] Replace the fixed auth temp path with a unique temp path.
- [ ] Decide self-hosted CLI callback registration. Either require explicit `redirectUri` for non-production `baseURL`, or seed trusted redirect URIs through setup.

### Phase 4: Align App Surfaces

- [ ] Treat `reauth-required` as signed-in for identity-bearing layouts.
- [ ] Make network-only controls show reconnect while local workspace controls remain usable.
- [ ] Keep profile queries in account surfaces, not auth state.
- [ ] Update stale docs that still show `auth.state.identity`, `OAuthSession`, `getToken`, or direct `openWebSocket: auth.openWebSocket` examples that contradict the current transport shape.

### Phase 5: Sync Identity Cleanup

- [ ] Reconcile `20260513T083755-open-workspace-clean-break.md` with `20260513T220000-document-sync-and-identity-collapse.md`.
- [ ] Use `replica` for client-claimed presence.
- [ ] Use server-stamped `subject` for verified account identity.
- [ ] Do not put profile fields in awareness by default.

## Validation Plan

Run these after Phase 1 and again after Phase 2:

```bash
bun test packages/auth/src/contract.test.ts
bun test packages/auth/src/node/machine-auth.test.ts
bun test packages/workspace/src/document/local-owner.test.ts
bun test packages/workspace/src/document/open-collaboration.test.ts
```

Run these greps before any implementation PR is marked done:

```bash
rg -n "OAuthSession|AuthIdentity|WorkspaceIdentityStore|/workspace-identity" packages apps docs specs
rg -n "getToken\\(|bearerToken|auth\\.state\\.identity|auth\\.state\\.email" packages apps docs specs
rg -n "deviceAuthorization|deviceAuthorizationClient|device_code|deviceCode" packages apps docs specs
perl -ne 'print "$ARGV:$.:$_" if /[\x{2013}\x{2014}]/' specs/20260515T010000-auth-canonical-path-audit.md
```

Expected results:

```txt
No live package or app references to OAuthSession.
No live package or app references to AuthIdentity.
No live package or app raw token getter.
No live package or app device authorization machine path.
No profile fields on AuthState.
No em dash or en dash in changed files.
```

Historical specs may still contain rejected terms, but new implementation specs must point back here and say they are historical.

## Rejected Alternatives

| Alternative | Refusal |
| --- | --- |
| Raw token getter on `AuthClient` | Refused. It leaks transport details and lets app code race refresh and verification. |
| Profile data in auth state | Refused. Profile is application data and can be queried where displayed. |
| `OAuthSession` compatibility shim | Refused. Old storage should fail validation and be ignored. |
| Better Auth device authorization machine path | Refused. OOB authorization code covers CLI, SSH, Docker, CI, and headless use with one token endpoint family. |
| Separate workspace identity store | Refused unless a real consumer needs independent identity persistence after auth storage is gone. No such consumer exists. |
| id-token-carried encryption keys | Refused. Encryption keys are local unlock capability material, not identity claims. |
| Cookie-first app resource auth | Refused for resource routes. Cookies remain for hosted login pages; app resources use OAuth bearer transport. |
| Clearing local Yjs data on auth failure | Refused. Local wipe is destructive and user-driven. |
| Awareness as verified identity | Refused. Awareness is client-claimed presence. Verified identity is server-stamped. |
| Daemon-specific auth state model | Refused. Daemon uses machine storage plus `createOAuthAppAuth`. |

## Open Questions

These are implementation choices, not architecture blockers:

1. Should machine logout await revoke, or should all logout remain storage-first and revoke-best-effort?
2. Should protected sync reject anonymous `openWebSocket` attempts in auth or in workspace sync?
3. Should `createSession` rebuild on a different `unlock.userId`, or should auth guarantee a signed-out transition first?
4. Should self-hosted CLI login require explicit trusted-client setup, or should setup seed redirect URIs?
5. Should `/api/me` remain both network verification and account profile fetch, or should account profile get a separate route later?

## Pause Conditions

Pause implementation if any of these become true:

1. Better Auth OAuth provider cannot support the required OOB authorization-code path without unsafe client registration.
2. `/api/me` cannot derive encryption keys without adding profile data back into auth state.
3. A real product requirement needs simultaneous multi-account local unlock in one runtime.
4. A migration would delete encrypted local Yjs data automatically.
5. A protected sync endpoint must accept anonymous WebSockets for a real shipping use case.
6. Self-hosted CLI login requires an unresolved product decision about trusted redirect registration.

## Commands Run

Local commands used while preparing this spec:

```bash
sed -n '1,240p' AGENTS.md
sed -n '1,260p' packages/auth/src/auth-contract.ts
sed -n '1,260p' packages/auth/src/auth-types.ts
sed -n '1,700p' packages/auth/src/create-oauth-app-auth.ts
sed -n '1,360p' packages/svelte-utils/src/session.svelte.ts
sed -n '1,260p' packages/workspace/src/document/local-owner.ts
sed -n '1,760p' apps/api/src/app.ts
sed -n '1,260p' apps/api/src/auth/create-auth.ts
sed -n '1,280p' apps/api/src/auth/resource-boundary.ts
sed -n '1,260p' apps/api/src/auth/single-credential.ts
sed -n '1,620p' packages/auth/src/contract.test.ts
sed -n '1,420p' packages/auth/src/node/machine-auth.ts
rg -n "(createOAuthAppAuth|createSession|AuthIdentity|OAuthSession|PersistedAuth|LocalUnlockBundle|openWebSocket|requireSignedIn|bearerToken|getToken|accessToken|local owner|localOwner|ownerId|userId)" packages apps specs/202605*.md specs/202604*.md
rg -n "\"(better-auth|@better-auth/oauth-provider|hono|yjs|y-protocols|y-indexeddb|svelte|@sveltejs/kit|@tauri-apps/plugin-opener|wxt|drizzle-orm|@libsql/client|@tanstack/ai|autumn-js|@tanstack/svelte-table|bits-ui|shadcn-svelte-extras)\"" --glob "package.json"
rg -n "(createSession\\(|auth\\.state\\.status|reauth-required|auth\\.fetch\\('/api/me'|openWebSocket: auth\\.openWebSocket|createLocalOwner|attachIndexedDb\\(|wipeLocalYjsData)" apps packages --glob "!**/*.test.ts"
sed -n '1,180p' /Users/braden/Code/ai/packages/react/src/use-chat.ts
sed -n '1,180p' /Users/braden/Code/ai/packages/openai/src/openai-provider.ts
sed -n '1,140p' /Users/braden/Code/ai/packages/provider/src/language-model/v1/language-model-v1.ts
```

External sources consulted:

```txt
Better Auth OAuth Provider docs
Cloudflare Durable Objects WebSockets docs
Hono middleware docs
Yjs document update docs
Yjs awareness and y-protocols docs
y-indexeddb docs
Svelte createSubscriber docs
SvelteKit load docs
Tauri opener docs
WXT storage docs
Drizzle Turso docs
Cloudflare Workers Turso docs
TanStack AI provider tools docs
jsrepo registry docs
Signal Sesame docs
Bitwarden log in vs unlock docs
shadcn-svelte installation docs
shadcn-svelte-extras introduction docs
TanStack Table Svelte state docs
Autumn usage tracking docs
```
