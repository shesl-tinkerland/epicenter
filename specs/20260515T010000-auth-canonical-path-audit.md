# Auth Canonical Path Audit

**Date**: 2026-05-15
**Status**: In Progress
**Author**: AI-assisted

## One Sentence

Epicenter has three defensible auth paths: browser redirect OAuth, extension WebAuthFlow OAuth, and machine OOB OAuth; all three converge on one persisted auth cell, one `/api/me` identity gate, one refresh and revoke surface, and one local-unlock state model.

## Current State

The center is already smaller than the old specs imply.

```txt
Better Auth
  owns:
    /auth/oauth2/authorize
    /auth/oauth2/token
    /auth/oauth2/revoke
    /auth/oauth2/consent
    /auth/* account/session machinery

Epicenter API
  owns:
    /api/me
    OAuth resource checks
    trusted first-party client projection
    CLI callback page

Epicenter clients
  own:
    launcher per runtime
    PersistedAuth storage per runtime
    AuthClient network gate
    local unlock lifecycle
```

The durable client shape is one cell:

```ts
PersistedAuth = {
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

Evidence:

| Surface | Evidence |
| --- | --- |
| Persisted shape | `packages/auth/src/auth-types.ts:48` defines `PersistedAuth = { grant, unlock }`. |
| Auth state | `packages/auth/src/auth-contract.ts:11` defines `signed-out`, `signed-in`, and `reauth-required`; both identity-bearing states carry `unlock`. |
| Client gate | `packages/auth/src/create-oauth-app-auth.ts:234` refreshes, calls `/api/me`, and refuses to attach bearer credentials until the current cell is verified. |
| Server identity | `apps/api/src/app.ts:275` mounts `/api/me`; `apps/api/src/auth/resource-boundary.ts:64` verifies token, audience, issuer, subject, scope, and user existence. |
| Server OAuth | `apps/api/src/app.ts:331` delegates `/auth/*` to Better Auth; `apps/api/src/auth/create-auth.ts:182` configures `oauthProvider`. |
| Trusted clients | `packages/constants/src/oauth.ts:23` lists dashboard, Fuji, Honeycrisp, Opensidian, Tab Manager, Zhongwen, and CLI. |

## Canonical Paths

There are three canonical paths, not one per app and not one per storage backend.

```txt
Browser apps
  createBrowserOAuthLauncher
    -> full-page redirect
    -> app /auth/callback route
    -> /auth/oauth2/token
    -> createOAuthAppAuth.applySignIn
    -> /api/me
    -> localStorage PersistedAuth

Extension
  createExtensionOAuthLauncher
    -> browser.identity.launchWebAuthFlow
    -> chromium extension redirect URL
    -> /auth/oauth2/token
    -> createOAuthAppAuth.applySignIn
    -> /api/me
    -> chrome.storage.local PersistedAuth

Machine
  createOobOAuthLauncher
    -> printed authorize URL
    -> hosted /auth/cli-callback page
    -> pasted code
    -> /auth/oauth2/token
    -> loginWithOob fetches /api/me
    -> ~/.epicenter/auth.json PersistedAuth
```

The runtime-specific parts are launcher and storage only.

| Runtime | Launcher necessity | Storage necessity | Canonical shared core |
| --- | --- | --- | --- |
| Browser | Full-page redirect is the normal SPA mechanism. | `localStorage` is synchronous and app-origin scoped. | `createOAuthAppAuth`, `PersistedAuth`, `/api/me`, refresh, revoke, bearer gate. |
| Extension | Chrome requires `browser.identity.launchWebAuthFlow`. | `chrome.storage.local` survives extension lifecycles. | Same. |
| Machine | OOB paste is the only one that works consistently across macOS, Linux, Windows, Docker, SSH, CI, and headless sessions. | `~/.epicenter/auth.json` avoids keychain, D-Bus, and desktop-session coupling. | Same after login; daemon uses `createOAuthAppAuth`. |

Rejected as canonical paths:

| Path | Rejection |
| --- | --- |
| Device authorization grant | Removed from current server config; it would add a second token endpoint family for the same machine login purpose. |
| Loopback PKCE for CLI | Better local UX, worse deployment envelope. Docker, SSH, CI, headless Linux, port binding, and callback firewall problems turn it into a platform matrix. |
| OS keychain storage | It adds platform branches without a reliable security win for unsigned CLI binaries and server-class Linux. |
| `/workspace-identity` | Superseded by `/api/me`; no current canonical role. |
| id_token-borne encryption keys | Rejected because encryption keys are capability material, not identity claims. |

## Subagent Findings

### Browser And Extension OAuth

Browser app auth files are structurally identical: `apps/dashboard/src/lib/platform/auth/auth.ts:13`, `apps/opensidian/src/lib/platform/auth/auth.ts:12`, `apps/fuji/src/lib/platform/auth/auth.ts:11`, `apps/honeycrisp/src/lib/platform/auth/auth.ts:11`, and `apps/zhongwen/src/lib/platform/auth/auth.ts:11` all create `createOAuthAppAuth` with app-specific client id, storage key, and redirect URI.

`packages/auth/src/oauth-launchers/index.ts:85` uses a single method for launch and callback: it first handles a callback URL, then redirects on missing callback state. Browser OAuth state and verifier are written at `packages/auth/src/oauth-launchers/index.ts:178`; callback state is checked at `packages/auth/src/oauth-launchers/index.ts:223`.

The extension has a necessary launcher difference. `apps/tab-manager/src/lib/platform/auth/auth.ts:30` creates `createExtensionOAuthLauncher`; `apps/tab-manager/src/lib/platform/auth/auth.ts:48` calls `browser.identity.launchWebAuthFlow`; temporary OAuth transaction state lives in `browser.storage.session` at `apps/tab-manager/src/lib/platform/auth/auth.ts:35`.

Inconsistencies:

- Browser callback pages are thin duplicates and redirect after `auth.startSignIn()` succeeds without checking `auth.state.status`; examples: `apps/dashboard/src/routes/auth/callback/+page.svelte:11`, `apps/fuji/src/routes/auth/callback/+page.svelte:10`.
- Browser apps import `PersistedAuth` from `@epicenter/auth`; Tab Manager imports it from `@epicenter/auth-svelte` at `apps/tab-manager/src/lib/platform/auth/auth.ts:12`.
- Auth-code token parsing does not validate `token_type` in `packages/auth/src/oauth-launchers/index.ts:296`; refresh parsing does validate bearer token type in `packages/auth/src/create-oauth-app-auth.ts:403`.
- `bearer.` WebSocket subprotocol prefix is duplicated in `packages/auth/src/create-oauth-app-auth.ts:70` and `packages/sync/src/auth-subprotocol.ts:25`.

### CLI And Daemon OOB

`packages/cli/src/commands/auth.ts:36` calls `loginWithOob()`. The OOB launcher builds the authorize URL at `packages/auth/src/node/oob-launcher.ts:105` and exchanges the pasted code at `packages/auth/src/node/oob-launcher.ts:135`. `packages/auth/src/node/machine-auth.ts:139` calls `/api/me`; `packages/auth/src/node/machine-auth.ts:147` writes `{ grant, unlock }`.

Machine storage is one file. `packages/auth/src/node/machine-tokens-store.ts:38` fixes the default path at `~/.epicenter/auth.json`; writes use a temp file and `0600` mode at `packages/auth/src/node/machine-tokens-store.ts:121`; POSIX reads reject too-open permissions at `packages/auth/src/node/machine-tokens-store.ts:68`.

Daemon consumers do not start interactive auth. `packages/cli/src/load-config.ts:257` creates one `AuthClient`, then passes it into daemon route startup at `packages/cli/src/load-config.ts:263`. App daemon routes consume that injected auth: Fuji at `apps/fuji/blocks/daemon-route.ts:32`, Honeycrisp at `apps/honeycrisp/blocks/daemon-route.ts:25`, Opensidian at `apps/opensidian/blocks/daemon-route.ts:21`, Zhongwen at `apps/zhongwen/blocks/daemon-route.ts:25`.

Inconsistencies:

- Logout deletes local storage before revoke and does not await revoke. `packages/auth/src/create-oauth-app-auth.ts:313` clears storage; `packages/auth/src/create-oauth-app-auth.ts:311` starts revoke as a detached promise. A short-lived CLI can exit before `/auth/oauth2/revoke` completes.
- OOB `state` is generated at `packages/auth/src/node/oob-launcher.ts:103`, but the CLI reads only code at `packages/auth/src/node/oob-launcher.ts:128` and does not verify state in the token request at `packages/auth/src/node/oob-launcher.ts:139`.
- The CLI callback page comment says the CLI checks state locally at `apps/api/src/auth-pages/cli-callback-page.tsx:31`; current code does not.
- Self-hosted or local `baseURL` can default to a redirect URI that is not registered. `packages/auth/src/node/oob-launcher.ts:82` defaults to `${baseURL}/auth/cli-callback`; `packages/constants/src/oauth.ts:77` registers only `https://api.epicenter.so/auth/cli-callback`.
- Concurrent writes use the fixed temp path `${filePath}.tmp` at `packages/auth/src/node/machine-tokens-store.ts:122`, so concurrent login or refresh is not as robust as the old spec claims.
- Machine status has its own vocabulary (`signedOut`, `valid`, `unverified`) at `packages/auth/src/node/machine-auth.ts:87`; browser core uses `signed-out`, `signed-in`, `reauth-required`.

### Server OAuth

`apps/api/src/auth/create-auth.ts:182` configures Better Auth OAuth provider with PKCE, trusted client ids, valid audiences, disabled dynamic registration, and the shared scopes. `apps/api/src/app.ts:173` seeds trusted OAuth clients before creating auth.

Trusted projection creates public PKCE authorization-code clients at `apps/api/src/auth/trusted-oauth-clients.ts:21`. Runtime maps browser and extension to `user-agent-based`, native to `native` at `apps/api/src/auth/trusted-oauth-clients.ts:86`.

`/api/me` is the single identity endpoint. `apps/api/src/app.ts:275` returns `{ user, encryptionKeys }`. `apps/api/src/auth/resource-boundary.ts:64` verifies the bearer token and `apps/api/src/auth/resource-boundary.ts:79` enforces `workspaces:open`.

Inconsistencies:

- Scope strings are duplicated in provider config, trusted projection, and tests: `apps/api/src/auth/create-auth.ts:189`, `apps/api/src/auth/trusted-oauth-clients.ts:5`, `apps/api/src/test-helpers/oauth.ts:7`.
- Trusted-client semantics are split between DB row `skipConsent: true` at `apps/api/src/auth/trusted-oauth-clients.ts:33` and provider `cachedTrustedClients` at `apps/api/src/auth/create-auth.ts:186`.
- PKCE/public-client semantics are repeated in trusted projection, provider config, and test helper setup.
- The resource-boundary comment says `/api/assets/*` requires `workspaces:open`, but public asset reads intentionally bypass auth through the public route mounted before the guard.
- Trusted client upsert does not overwrite every nullable client metadata field, so stale fields can survive from earlier DB rows.

### Consumers And Session Behavior

Core semantics are coherent:

```txt
signed-out
  no persisted cell
  dispose local workspace

signed-in
  persisted cell exists
  unlock available immediately
  network bearer only after /api/me verifies this runtime

reauth-required
  persisted cell exists
  unlock remains available
  network bearer is paused
```

`packages/svelte-utils/src/session.svelte.ts:27` treats `signed-in` and `reauth-required` as the same local workspace lifetime and disposes only on `signed-out`. The local owner reads encryption keys lazily from current auth state at `packages/svelte-utils/src/session.svelte.ts:37`.

Inconsistencies:

- Dashboard gates its signed-in layout on exact `signed-in` at `apps/dashboard/src/routes/(signed-in)/+layout.svelte:25`, so `reauth-required` is visually treated like signed-out even though local workspace semantics say it is still identity-bearing.
- Tab Manager handles the distinction more honestly by keeping the app open and showing reauth copy in `apps/tab-manager/src/entrypoints/sidepanel/SignedInApp.svelte:84`.
- `/api/me` has two jobs: auth-internal verification and account/profile fetch. A cold `auth.fetch('/api/me')` can make two `/api/me` requests, covered by `packages/auth/src/contract.test.ts:270`.
- Svelte lifecycle behavior has no direct test file under `packages/auth-svelte` or `packages/svelte-utils`; current confidence comes from implementation plus `packages/auth/src/contract.test.ts`.

## Canonical-Path Proposal

Keep exactly three launcher paths:

1. Browser redirect OAuth.
2. Extension WebAuthFlow OAuth.
3. Machine OOB OAuth.

Keep exactly one shared auth runtime after launch:

```txt
OAuthTokenGrant
  -> /api/me
  -> PersistedAuth
  -> createOAuthAppAuth
  -> auth.fetch / auth.openWebSocket
  -> resource-boundary verification
```

Do not add a fourth path for daemon, Docker, SSH, CI, local development, or self-hosting. Those are configuration and callback-registration concerns inside the machine OOB path, not separate auth models.

## Collapse Plan

Pause before changing production code. The next implementation spec should decide and then execute these collapses:

- [ ] Make revoke semantics explicit. Either await revoke before reporting logout success for machine auth, or name it best-effort everywhere and test that exact behavior.
- [ ] Fix OOB state semantics. Either paste and verify `{ code, state }`, render state as part of the copyable callback payload, or remove `state` and comments that claim it is checked. Do not leave security theater.
- [ ] Decide self-hosted CLI redirect registration. Either register localhost and self-host callback URIs intentionally, or require explicit `redirectUri` for non-production `baseURL`.
- [ ] Replace fixed `.tmp` auth-file writes with per-process or random temp paths before claiming concurrent login is safe.
- [ ] Extract the shared OAuth token-response parser used by browser, extension, refresh, and OOB paths, including token type validation.
- [ ] Extract or import the shared bearer subprotocol prefix instead of defining it in two packages.
- [ ] Collapse browser callback routes to one shared callback component or helper that redirects only after `auth.state.status === 'signed-in'`.
- [ ] Normalize `reauth-required` UI handling: identity-bearing layouts stay mounted, network-only controls show reconnect.
- [ ] Move shared scope strings into one exported server-auth constant and reuse it in provider config, trusted projection, and tests.
- [ ] Update CLI README examples so daemon routes consume injected `auth`, not route-local `createMachineAuthClient()`.

## Rejected Alternatives

| Alternative | Reason |
| --- | --- |
| Add compatibility layers for old `OAuthSession` | `PersistedAuth` is already the landed clean break; compatibility adds another session shape with no current caller. |
| Restore device authorization | Solves only machine login and reintroduces a second grant family where OOB already works across the deployment matrix. |
| Make `/api/me` return long-lived profile state for auth | Profile moved to application data; auth should carry unlock and grant, not decorative account labels. |
| Add per-platform machine auth backends | Creates more storage semantics instead of removing them. File storage is the canonical machine store. |
| Use browser cookies for first-party SPAs | It is shorter for one browser app, but it breaks the cross-client OAuth resource boundary shared by extension, CLI, daemon, and browser apps. |

## Open Questions

- Should machine logout be stronger than browser logout by awaiting revoke, or should `AuthClient.signOut()` itself expose an awaited revoke mode?
- Should OOB paste include the state visibly, or should the callback page encode a single copyable payload that the CLI parses?
- Is self-hosted CLI login a supported product path now, or is it future work behind explicit trusted-client setup?
- Should `/api/me` split auth verification from account/profile fetching, or is the duplicate cold-call acceptable because it keeps one identity endpoint?
- Should machine `status` reuse core auth vocabulary, or does CLI output deserve command-specific names?
- Is `reauth-required` a signed-in route state everywhere, with only network controls paused? If yes, Dashboard currently disagrees.

## Verification Checklist

Evidence collected:

- [x] Read `specs/20260514T120000-machine-auth-oob-clean-break.md`.
- [x] Read `specs/20260514T200000-api-me-three-field-token-bundle.md`.
- [x] Read `packages/auth/src/create-oauth-app-auth.ts`.
- [x] Read `packages/auth/src/node/machine-auth.ts`.
- [x] Read `packages/auth/src/node/oob-launcher.ts`.
- [x] Read `packages/auth/src/node/machine-tokens-store.ts`.
- [x] Read `packages/auth/src/auth-types.ts`.
- [x] Read `packages/constants/src/oauth.ts`.
- [x] Read `apps/api/src/auth/create-auth.ts`.
- [x] Read `apps/api/src/app.ts`.
- [x] Read all `apps/*/src/lib/platform/auth/auth.ts` files.
- [x] Spawned browser and extension OAuth mapping subagent.
- [x] Spawned CLI and daemon OOB mapping subagent.
- [x] Spawned server OAuth mapping subagent.
- [x] Spawned consumer session behavior mapping subagent.

Validation commands:

- [x] `bun test packages/auth`: 47 pass, 0 fail.
- [x] `bun test apps/api`: 64 pass, 0 fail.

No production code has been changed by this audit spec. The collapse plan above includes security and product decisions, so implementation should pause for explicit approval before editing runtime auth behavior, deleting tests, changing OAuth client contracts, or changing persisted auth shape.
