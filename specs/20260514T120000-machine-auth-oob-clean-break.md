# Machine Auth: OOB Code Paste + File-Backed Session

**Date**: 2026-05-14
**Status**: Implemented (2026-05-15). Phases 1-2 landed via `specs/20260514T200000-api-me-three-field-token-bundle.md` Waves 1-2; Phases 3-4 landed via PR #1762 (`specs/20260514T210000-execute-oob-cli-phases-3-4.md`). Only Phase 6 (CLI README OOB walkthrough) is open.
**Branch**: `codex/pr-workspace-api-surface` (target; implementation landed on `codex/wave1-cli-callback-and-health`, merged via #1762)
**Depends on**: `specs/20260512T111335-post-oauth-audit-remediation.md` (resolves Phase 4)
**Composes with**: `specs/20260514T200000-api-me-three-field-token-bundle.md` (defines the persisted shape; this spec is the CLI's flavor of that architecture)
**Resolves**: `specs/20260512T111335-post-oauth-audit-remediation.md` Open Question 2 ("Is CLI/device login currently shipped to users?")
**Supersedes**: `specs/20260512T111335-post-oauth-audit-remediation.md` Phase 4 Option A and Option B (loopback PKCE recommendation withdrawn; device authorization restoration declined).

## Status update (post-api-me)

Reality on `main` after the `/api/me` spec's Waves 1-4 landed (2026-05-14):

| Phase | Originally proposed here | Actual landing | Outcome |
| --- | --- | --- | --- |
| 1 | Server callback page + constants + trusted-client projection | Landed in api-me Wave 1 (commits `9f32ea0bc` and follow-ons) | **DONE** |
| 2 | File-backed `machine-session-store.ts` persisting `OAuthSession` | api-me Wave 2 replaced this with `machine-tokens-store.ts` persisting `PersistedAuth = { grant, unlock }` (commit `58a5e9b36`) | **DONE, with a sharper shape** |
| 3 | OOB launcher (`oob-launcher.ts`) | Landed in PR #1762 Wave 1 (commit `095ed0833`) | **DONE** |
| 4 | Rewrite `machine-auth.ts` to use the OOB launcher | Landed in PR #1762 Wave 2 (commit `51efc2853`); CLI wire-up in Wave 3 (`3c5c875e2`); tests in Wave 4 (`f2f04c763`); revoke-ordering fix in `6f15a2c72` | **DONE** |
| 5 | Daemon smoke + consumer audit | Daemons now boot through the real `createMachineAuthClient` path; orchestration guide moves the next lane to `codex/daemon-shared-auth` (Phase 1 of single-daemon spec) | **DONE for smoke; consumer audit folds into daemon-shared-auth** |
| 6 | Docs | api-me Wave 4 already deleted `/workspace-identity` and updated `docs/encryption.md` references | Mostly done; CLI README still needs the OOB walkthrough: **OPEN** |

The persisted-shape and identity-source decisions below are **superseded by the api-me spec**. Where this spec says `OAuthSession`, read `PersistedAuth`. Where it says `/workspace-identity`, read `/api/me`. Where it says `machine-session-store.ts`, read `machine-tokens-store.ts`. The narrative below is preserved with these substitutions called out inline.

The conceptual goal of this spec is still correct: an OOB code paste flow against `/auth/oauth2/token`, file-backed persistence at `~/.epicenter/auth.json` (mode 0o600), no Bun.secrets dependency. Only the shape on disk and the identity endpoint name changed under us, and both changed for the better.

## One Sentence

`epicenter auth login` prints an OAuth 2.1 authorize URL, the user signs in on the hosted portal, copies the displayed code, pastes it into the terminal, the CLI exchanges the code at `/auth/oauth2/token` and calls `/api/me` for the local-unlock bundle, then a `PersistedAuth` cell (`{ grant, unlock }`) lands at `~/.epicenter/auth.json` (0600); every daemon and script reads that file through `createOAuthAppAuth` like every other client.

This is the cohesion test for the spec. Anything that does not protect that sentence (one flow, one file, one auth surface, identity from the same source every other client uses) belongs elsewhere. Specifically excluded: keychain storage, loopback listener, device-grant restoration, personal access tokens, per-platform fallback logic, id_token-borne capability claims, and any CLI-specific identity-decode path.

## Overview

The `apps/api` server speaks OAuth 2.1 through Better Auth's `oauthProvider` plugin (authorize, token, revoke, introspect, userinfo). The CLI in `packages/auth/src/node/machine-auth.ts` and the daemons under `apps/*/blocks/daemon-route.ts` are the only consumers of machine auth.

Today the CLI calls dead endpoints (`/auth/device/code`, `/auth/device/token`, `/auth/get-session`) and persists through `Bun.secrets`, which fails on every server-class Linux environment we care about. This spec replaces the entire CLI auth surface with a single OOB (out-of-band) paste flow against the existing OAuth 2.1 endpoints, and replaces the keychain with a single file at `~/.epicenter/auth.json`. No backend abstraction, no opt-in mode, no platform branch.

The daemon path (`createMachineAuthClient` -> `createOAuthAppAuth`) already works and stays unchanged in shape; only the storage layer it composes with is rewritten.

## Motivation

### Current State

Three pieces conspire to make CLI auth non-functional today.

**Client calls endpoints that do not exist on this server**:

```ts
// packages/auth/src/node/machine-auth.ts:28-32
const rawDefaultAuthClient = createAuthClient({
    baseURL: EPICENTER_API_URL,
    basePath: '/auth',
    plugins: [deviceAuthorizationClient()],
});

// :103 POSTs /auth/device/code
const { data: code } = await authClient.deviceCode({...});

// :255 POSTs /auth/device/token
const { data } = await authClient.deviceToken({...});

// :328 GETs /auth/get-session, expects WorkspaceIdentity shape
const { data } = await authClient.getSession({...});
```

Server plugin set installs `jwt()` and `oauthProvider()` only (`apps/api/src/auth/create-auth.ts:175-196`). `deviceAuthorization()` is not registered. `/auth/get-session` exists (Better Auth core handler) but returns a Better Auth session shape, not the `WorkspaceIdentity` the client asserts.

**Logout never revokes**:

```ts
// machine-auth.ts:207
await authClient.signOut({
    fetchOptions: {
        headers: { Authorization: `Bearer ${session.accessToken}` },
    },
});
```

`/auth/sign-out` clears Better Auth's session cookie. It does not revoke the OAuth refresh token. After "logout" the refresh token remains valid until natural expiry.

**Storage refuses to work on servers**:

```ts
// packages/auth/src/node/machine-session-store.ts
const machineSessionOptions = {
    service: 'epicenter.auth.session',
    name: 'current',
};

await backend.set({  // backend defaults to Bun.secrets
    ...machineSessionOptions,
    value: JSON.stringify(OAuthSession.assert(session)),
});
```

On Linux, `Bun.secrets` resolves to libsecret via `dlopen("libsecret-1.so.0")`. It throws when:
- The shared library is not installed (minimal server images, Alpine without `community/`).
- No D-Bus session bus is running (the typical case in Docker containers, CI runners, SSH-only hosts).
- A keyring daemon is not running or not unlocked.

On macOS, the same binary running via SSH without a console session triggers `errSecInteractionNotAllowed`.

### Problems

1. **CLI cannot complete login against the current server.** Three endpoint contracts are stale.
2. **Logout cannot revoke.** Token theft has a 30-day attack window even after the user runs `epicenter auth logout`.
3. **Storage is unusable on the deployment surface we ship into.** Every daemon-running environment (Linux servers, Docker, CI, SSH-only sessions) hits a hard throw before sign-in is possible.
4. **The identity source diverges from every other client.** `AuthClient` consumers (`apps/dashboard`, `apps/fuji`, etc.) load identity from `/workspace-identity`. CLI uniquely loads from `/auth/get-session` and asserts a shape that endpoint does not return.
5. **Constants and trusted-client projection still encode `runtime: 'device'`.** That value flows into `toOAuthClientType(...)` which only exists to map `'device'` to `'native'`. After this change, the union shrinks and the helper disappears.

### Desired State

```txt
~/.epicenter/auth.json (mode 0o600)   --- shape per api-me spec ---
  grant
    accessToken            string  JWT bearer for /api/*
    refreshToken           string  opaque rotation key
    accessTokenExpiresAt   number  ms-since-epoch; mirrors /token's expires_at
  unlock
    userId                 string  same-user guard; binds keys to a subject
    encryptionKeys         EncryptionKeys  decrypts local Yjs blobs offline

  profile = { email } lives in memory only (not persisted; rehydrated from
  /api/me when online)
        |
        v
createOAuthAppAuth(
  baseURL,
  clientId,
  persistedAuthStorage = file at ~/.epicenter/auth.json,
  launcher = OOB paste launcher,
  refreshOAuthToken = POST /auth/oauth2/token,
  revokeOAuthRefreshToken = POST /auth/oauth2/revoke,
)
        |
        v
AuthClient
  state, fetch(), openWebSocket(), startSignIn(), signOut()
  state.unlock is the persisted local-decrypt capability;
  state.profile?.email is in-memory only (cold-boot offline shows
  "Account" until /api/me succeeds). Same shape and same source as
  every browser / extension client.
```

`epicenter auth login` triggers the OOB launcher. The launcher:

1. Generates a PKCE `code_verifier` and `code_challenge` (S256).
2. Builds an authorize URL: `GET /auth/oauth2/authorize?response_type=code&client_id=epicenter-cli&redirect_uri=https://api.epicenter.so/auth/cli-callback&scope=openid+profile+email+offline_access+workspaces:open&state=...&code_challenge=...&code_challenge_method=S256&resource=https://api.epicenter.so`.
3. Prints the URL. Attempts to open it best-effort. Tells the user "if your browser does not open, copy the URL above."
4. Reads the code from stdin.
5. Exchanges at `/auth/oauth2/token` with `grant_type=authorization_code`. The response is `{ access_token, refresh_token, expires_in, token_type }`. The CLI writes the `grant` section of `PersistedAuth`.
6. Calls `GET /api/me` with the new access token to load `{ user, encryptionKeys }`. Same identity source every browser / extension client uses (`createOAuthAppAuth.fetchProfile`).
7. Writes the `unlock` section (`userId` + `encryptionKeys`) to `~/.epicenter/auth.json`. `profile.email` from the response is held in memory only and surfaced through `auth.state.profile`.

The `unlock` section persists so daemons and scripts can decrypt local Yjs data on cold boot without a network round-trip. This matches the browser's `localStorage` behavior (browser and extension persist the same `PersistedAuth` arktype) and preserves local-first offline use.

`epicenter auth logout` revokes the refresh token (`POST /auth/oauth2/revoke`) and deletes the file.

Daemons and scripts read the file through the same `createOAuthAppAuth` instance and never touch the launcher (`launcher.startSignIn` returns `Ok(null)`, which `createOAuthAppAuth` treats as "no sign-in available in this environment").

## Research Findings

### Better Auth `oauthProvider` plugin

Verified against `better-auth/better-auth` via DeepWiki:

| Question | Finding | Spec impact |
| --- | --- | --- |
| Does `/oauth2/authorize` redirect to the registered `redirect_uri` with `?code&state`? | Yes. RFC 6749 / OAuth 2.1 conformant. Implemented in `packages/oauth-provider/src/authorize.ts`. | The CLI registers an HTTPS callback on `api.epicenter.so` and the auth server itself renders the code page on receipt. |
| Is an HTTPS URL on the same authorization server a valid `redirect_uri` for a `type: 'native'` public client with `requirePKCE: true`? | Yes. The plugin is permissive about claimed-HTTPS native redirects (RFC 8252 explicitly allows this; the plugin is not loopback-only). Exact string match for non-loopback URIs. | We register `https://api.epicenter.so/auth/cli-callback` exactly. No port wildcard concerns. |
| Does `POST /oauth2/token` with `grant_type=authorization_code` from a public PKCE client return `access_token`, `refresh_token` (when `offline_access` granted), and rotate the refresh token on subsequent refreshes? | Yes. `refresh_token` rotates on every refresh. Default `refreshTokenExpiresIn` is 30 days, independent of session expiry. | The CLI gets a long-lived refresh token. Same daemon refresh path that already works. |
| Is `/oauth2/revoke` RFC 7009 compliant, and does revoking the refresh token invalidate the access tokens issued from it? | Yes on both counts. | Logout calls revoke and is honest about what it does. |
| Are scopes carried into the access token JWT for trusted clients with `skipConsent: true`? | Yes. `openid profile email offline_access workspaces:open` flow through to the JWT `scope` claim. | `/workspace-identity` already enforces `workspaces:open`; nothing new needed. |

Source files referenced by DeepWiki: `packages/oauth-provider/src/authorize.ts`, `packages/oauth-provider/src/oauth.ts`, `packages/oauth-provider/src/token.test.ts`, `packages/oauth-provider/src/register.test.ts`, `docs/content/docs/plugins/oauth-provider.mdx`.

### Hono on Cloudflare Workers

Verified against `honojs/hono` via DeepWiki:

| Question | Finding | Spec impact |
| --- | --- | --- |
| What is the idiomatic HTML response? | `c.html(JSX)` with the JSX runtime. Sets `Content-Type: text/html; charset=UTF-8` automatically. | We add `auth-pages/cli-callback-page.tsx` and `auth-pages/index.tsx::renderCliCallbackPage()` matching the existing convention. |
| Is there route specificity? | Yes. Hono's SmartRouter chooses the most specific match, not registration order. | `app.get('/auth/cli-callback', ...)` wins over `app.on(['GET','POST'], '/auth/*', ...)` regardless of order. The catch-all does not need to be moved. |
| Is there a security-headers helper? | Yes. `secureHeaders()` middleware sets CSP, X-Frame-Options, X-Content-Type-Options, Referrer-Policy, Strict-Transport-Security as a group. | Apply `secureHeaders()` to this single route; we do not change global behavior. |
| Does Hono escape user input in JSX? | JSX text nodes are escaped. Attributes are escaped. Raw HTML interpolation (`<div innerHTML={...} />` and similar) is not. | We render `code` and `state` as text nodes, never as raw HTML or unescaped attribute values. |
| Response size limits on Workers? | Streaming up to 128 MB. Our page is under 4 KB. | Non-issue. |

### Cloudflare Workers HTML response

Verified against `cloudflare/cloudflare-docs` via DeepWiki:

| Concern | Recommendation | Spec impact |
| --- | --- | --- |
| Edge and browser caching of a page that contains a short-lived sensitive code | `Cache-Control: no-store` on the response. `no-store` is stronger than `no-cache`. | Set explicitly on the callback response. |
| Cloudflare HTML mutation features (Rocket Loader, Auto Minify, Email Obfuscation) | Either set `Cache-Control: no-transform` or disable per-route via Page Rules. `no-transform` is the canonical Worker-side signal. | Set both `Cache-Control: no-store, no-transform`. Optionally document the Page Rule as a belt-and-suspenders measure. |
| Additional security headers worth setting | `X-Frame-Options: DENY`, `Permissions-Policy`, `Strict-Transport-Security`. | All covered by Hono's `secureHeaders()` with sane defaults. |
| TLS handling | Cloudflare terminates TLS at the edge. HSTS is set at the Worker response layer. | `secureHeaders()` handles this. |

## Design Decisions

| Decision | Class | Choice | Rationale |
| --- | --- | --- | --- |
| Flow shape | 2 coherence | OOB code paste, no localhost listener, no device grant | One canonical implementation across all environments (laptop, server, Docker, CI, SSH). The `cohesive-clean-breaks` asymmetric win: refusing ~10% of UX polish (no auto-close tab) collapses ~50% of the client code surface and removes the need for any platform-specific fallback. |
| OAuth grant | 1 evidence | `authorization_code` + PKCE (S256) | Already configured on the `epicenter-cli` trusted client (`grantTypes: ['authorization_code']`, `requirePKCE: true`). Server needs no plugin additions. |
| Redirect URI | 1 evidence | `https://api.epicenter.so/auth/cli-callback` (exact, HTTPS, claimed-HTTPS-native) | DeepWiki-confirmed `oauthProvider` accepts HTTPS redirects for native clients. Auth server itself renders the code page. No localhost binding. No port matching. No DNS surprise. |
| Identity source | 2 coherence | `GET /workspace-identity` once at sign-in; cached in `OAuthSession.identity` | Same identity surface as every browser/extension client (`createOAuthAppAuth.loadIdentity`). No CLI-specific identity path. One HTTP round-trip per login is acceptable; identity does not change inside a session for any reason that matters (encryption keys rotate only on server-side `BETTER_AUTH_SECRET` rotation, which is an incident, not routine). Persisted on disk so cold-boot offline can still decrypt local data. A future cosmetic rename to `/api/me` (aligning with REST convention used by GitHub/Stripe/Notion/Linear/etc.) is tracked separately and does not change this design. |
| Persisted shape on disk | 2 coherence | `OAuthSession = { tokens: { accessToken, refreshToken, accessTokenExpiresAt }, identity: { user, encryptionKeys } }` | Same arktype the browser writes to localStorage and the extension writes to chrome.storage. One schema, three storage cells. Identity nested under the session so local-first offline cold-boot still works (persisted `encryptionKeys` are what lets the daemon decrypt local Yjs state when offline). Refused: per-platform variants, separated tokens-only vs identity-only files. |
| Token storage location | 2 coherence | `~/.epicenter/auth.json`, mode 0o600 | Matches `~/.aws/credentials`, `~/.gcloud/credentials.db`, `~/.codex/auth.json`, `~/.config/gh/hosts.yml`. Disk-at-rest protection is provided by FileVault/BitLocker/LUKS at the OS layer in 2026. |
| Token storage backend | 2 coherence | File only. No OS keychain. No backend abstraction. | The macOS keychain ACL only meaningfully gates by code signature; the published CLI binary is unsigned. Linux libsecret and Windows DPAPI both gate per-user, the same protection as `chmod 0o600`. Keeping both is speculative complexity for a security delta that depends on shipping signed binaries we do not ship. |
| Logout semantics | 1 evidence | `POST /auth/oauth2/revoke` with the refresh token, then delete the file | RFC 7009. Revoking the refresh token also invalidates issued access tokens (DeepWiki-confirmed). Old `signOut` path was misleading. |
| Refresh path | 0 (no change) | `createOAuthAppAuth` default (`POST /auth/oauth2/token`) | Already works for browser clients. Reused unchanged. |
| `runtime` taxonomy | 2 coherence | Drop `'device'` variant from `EPICENTER_TRUSTED_OAUTH_CLIENTS`. CLI becomes `'native'`. | `'device'` was a placeholder for the device grant; no other code path needs the distinction. `toOAuthClientType` collapses to a two-arm switch (`browser`/`extension` -> `'user-agent-based'`, `native` -> `'native'`). |
| Callback page renders | 2 coherence | `c.html(<CliCallbackPage code={code} state={state} error={error} />)` in `apps/api/src/app.ts` reading from `apps/api/src/auth-pages/` | Matches existing pattern for `/sign-in`, `/consent`, `/signed-in`. No new render mechanism. |
| Static asset (Page Rule) | 3 taste under constraint | Apply `secureHeaders()` middleware + `Cache-Control: no-store, no-transform` on the route; do not require a manual dashboard Page Rule | Self-contained: a fresh deploy does not depend on operator action to be safe. `no-transform` is honored by Cloudflare for Rocket Loader / Minify / Email Obfuscation on this response. |
| Headless `--no-browser` flag | 3 taste under constraint | Not needed | The flow already works without opening a browser. The launcher always prints the URL; the browser-open is best-effort. A flag would be a duplicate signal. |
| Daemon launcher | 2 coherence | `launcher.startSignIn` returns `Ok(null)` (unchanged) | A daemon must not spawn an interactive launcher. Re-login is always a human running `epicenter auth login`. |

## Relationship To Adjacent Specs

| Source | Relationship | Conflict? |
| --- | --- | --- |
| `specs/20260512T111335-post-oauth-audit-remediation.md` Phase 4 | This spec is the resolution of Phase 4. Option A (loopback PKCE) is withdrawn in favor of OOB paste; Option B (restore device authorization) is rejected. | No. The audit spec stays the umbrella; this is the concrete decision it required. |
| `specs/20260514T154500-id-token-bearing-encryption-keys.md` | **Retracted** on 2026-05-14. This spec is no longer coupled to it. CLI loads identity from `/workspace-identity` like every other client. | No. The retracted spec proposed routing encryption keys through id_token claims; that path introduced a leakage-surface regression and was rejected. See its `## Retraction` section. |
| `specs/20260511T150000-final-oauth-auth-architecture.md` | Reuses `createOAuthAppAuth`, `OAuthSession`, `/oauth2/token`, `/oauth2/revoke`, `/workspace-identity` unchanged. | No. This spec is a CLI-specific launcher; the architecture is unchanged at the endpoint level. |
| `specs/20260512T220000-session-two-axis-cohesive-reshape.md` | Daemon `AuthClient.state` still follows `SessionPayload<T> \| null`. Nothing about the OOB flow changes session reshape. | No. |
| `specs/20260503T180000-auth-snapshot-three-state-clean-break.md` | Browser-side snapshot work is independent. | No. |
| `docs/encryption.md` | Currently references `/auth/get-session` in places. After this spec, that reference is incorrect for any CLI mention. | Documentation drift; fix as part of Phase 6 here. |

## Architecture

### CLI Login Flow

```txt
$ epicenter auth login
        |
        v
generate code_verifier, code_challenge = base64url(sha256(verifier))
generate state = random(16)
        |
        v
print:
  Open this URL in any browser to sign in:
    https://api.epicenter.so/auth/oauth2/authorize?
      response_type=code
      &client_id=epicenter-cli
      &redirect_uri=https%3A%2F%2Fapi.epicenter.so%2Fauth%2Fcli-callback
      &scope=openid+profile+email+offline_access+workspaces%3Aopen
      &state=<state>
      &code_challenge=<challenge>
      &code_challenge_method=S256
      &resource=https%3A%2F%2Fapi.epicenter.so
  (attempt to open it in your browser too)
        |
        v
read from stdin:
  Paste the code from the success page here: _
        |
        v
POST https://api.epicenter.so/auth/oauth2/token
  grant_type=authorization_code
  code=<pasted code>
  code_verifier=<verifier>
  client_id=epicenter-cli
  redirect_uri=https://api.epicenter.so/auth/cli-callback
  resource=https://api.epicenter.so
        |
        v
response: { access_token, refresh_token, expires_in, token_type: 'bearer' }
        |
        v
GET /workspace-identity
  Authorization: Bearer <access_token>
  credentials: omit
response: { user: { id, email }, encryptionKeys: [...] }
  (same endpoint, same shape every browser / extension client consumes
   via createOAuthAppAuth.loadIdentity)
        |
        v
write OAuthSession to ~/.epicenter/auth.json (mode 0o600)
  { tokens: { accessToken, refreshToken, accessTokenExpiresAt },
    identity: { user, encryptionKeys } }
        |
        v
print: Signed in as <identity.user.email>.
```

### Server Callback Page Flow

```txt
Browser
  GET /auth/oauth2/authorize?...&redirect_uri=https://api.epicenter.so/auth/cli-callback
        |
  /sign-in (if not signed in) -> /consent (skipConsent: true bypasses) -> code issued
        |
  302 -> https://api.epicenter.so/auth/cli-callback?code=<code>&state=<state>
        |
        v
Hono route handler (apps/api/src/app.ts)
  app.get('/auth/cli-callback', secureHeaders(), async (c) => {
    const code  = c.req.query('code');
    const state = c.req.query('state');
    const error = c.req.query('error');
    const errorDescription = c.req.query('error_description');
    c.header('Cache-Control', 'no-store, no-transform');
    return c.html(renderCliCallbackPage({ code, state, error, errorDescription }));
  });
        |
        v
HTML page renders:
  +------------------------------------------------+
  | Signed in to Epicenter CLI                     |
  |                                                |
  | Copy this code and paste it into your terminal:|
  |                                                |
  |   +----------------------------------------+   |
  |   |  XJ8K-2MNQ-LPVR-AB91-9DCE              |[Copy]
  |   +----------------------------------------+   |
  |                                                |
  | You can close this tab once you've pasted it.  |
  +------------------------------------------------+
```

The browser never sees the actual access token or refresh token. It only sees a one-time authorization code that is useless without the PKCE verifier held in the CLI process.

### Daemon Auth Composition (Unchanged)

```txt
apps/*/blocks/daemon-route.ts
  defineFujiDaemon().start({ projectDir })
        |
        v
createMachineAuthClient()
        |
        +-- loadMachineSession() ── reads ~/.epicenter/auth.json
        |
        v
createOAuthAppAuth({
  baseURL,
  clientId: 'epicenter-cli',
  sessionStorage: {
    get: () => currentSession,
    set: async (next) => writeMachineSession(next),
  },
  launcher: { startSignIn: async () => Ok(null) },   // daemon never logs in interactively
  refreshOAuthToken: refreshOAuthTokenWithEndpoint,   // default; POST /auth/oauth2/token
  revokeOAuthRefreshToken: revokeOAuthRefreshTokenWithEndpoint,  // default; POST /auth/oauth2/revoke
})
        |
        v
{ state, fetch(), openWebSocket(), signOut() }
```

### File Layout

```txt
~/.epicenter/auth.json (mode 0o600)
  shape: OAuthSession = {
    tokens: {
      accessToken: string,
      refreshToken: string,
      accessTokenExpiresAt: number,
    },
    identity: {
      user: { id: string, email: string },
      encryptionKeys: EncryptionKeys,
    },
  }
  scope: user-level credentials, shared by every app that uses createMachineAuthClient
  notes:
    - SAME arktype the browser persists to localStorage and the extension to chrome.storage.
    - Identity is nested inside the session so cold-boot offline can still decrypt
      local Yjs state without a network round-trip (local-first invariant).
    - Identity refreshes only when a new sign-in or an explicit reauth occurs;
      encryption keys do not change inside a session for any reason users observe.
    - No version field; the arktype evolution path is "introduce a new key, deprecate
      the old, run a migration that costs one re-login per user."

<project>/.epicenter/
  daemon/*.sock, daemon/*.pid, daemon/*.log, daemon/*.yjs.log, etc.
  scope: per-project, per-app daemon runtime state
  NEVER contains credentials
```

## Implementation Plan

Ordered patches. Each step lands as one commit unless noted.

### Phase 1: Server callback page  [DONE: api-me Wave 1]

Landed in commits `9f32ea0bc` (`/api/me` route) and follow-on Wave 1 commits. The CLI callback page, the `/auth/cli-callback` route, the constants update, and the `toOAuthClientType` collapse are all on `main`. Items below are preserved as the original task list; treat all as `[x]`.

- [x] **1.1** Add `apps/api/src/auth-pages/cli-callback-page.tsx`. Export `CliCallbackPage` returning JSX. Props: `{ code?: string; state?: string; error?: string; errorDescription?: string }`. Render layout:
  - Success branch (when `code` is present): heading "Signed in to Epicenter CLI", monospace `<code>` block containing `code`, a "Copy" button that uses `navigator.clipboard.writeText(code)` from an inline script tag in `auth-pages/scripts/`, body text "Paste it into the terminal where you ran `epicenter auth login`."
  - Error branch (when `error` is present): heading "Sign-in failed", body text showing `error` and `errorDescription` literally (these come from Better Auth and are not user-injected). Link back to home.
  - Missing-code fallback: same as error branch with `error="missing_code"`.
  Use the existing `AuthLayout` (`apps/api/src/auth-pages/layout.tsx`) so styling matches `/sign-in` and `/consent`.
- [ ] **1.2** Export `renderCliCallbackPage(...)` from `apps/api/src/auth-pages/index.tsx` mirroring the existing helpers.
- [ ] **1.3** Wire the route in `apps/api/src/app.ts`. Register before or after `/auth/*` (specificity wins per Hono semantics, confirmed via DeepWiki):
  ```ts
  app.get('/auth/cli-callback', secureHeaders(), async (c) => {
      c.header('Cache-Control', 'no-store, no-transform');
      const code = c.req.query('code');
      const state = c.req.query('state');
      const error = c.req.query('error');
      const errorDescription = c.req.query('error_description');
      return c.html(renderCliCallbackPage({ code, state, error, errorDescription }));
  });
  ```
  Import `secureHeaders` from `hono/secure-headers`.
- [ ] **1.4** Update `packages/constants/src/oauth.ts`: change the CLI entry to `runtime: 'native'`, `redirectUris: ['https://api.epicenter.so/auth/cli-callback']`. Update the JSDoc on `EPICENTER_CLI_OAUTH_CLIENT_ID` to describe loopback PKCE removal and the new claimed-HTTPS-native redirect. Drop every mention of the device authorization plugin.
- [ ] **1.5** Update `apps/api/src/auth/trusted-oauth-clients.ts`. `toOAuthClientType` collapses to:
  ```ts
  function toOAuthClientType(runtime) {
      switch (runtime) {
          case 'browser':
          case 'extension':
              return 'user-agent-based';
          case 'native':
              return 'native';
      }
  }
  ```
  The exhaustiveness check shrinks; TypeScript will flag any remaining `'device'` reference.
- [ ] **1.6** Manual smoke against dev API: open `https://localhost:8787/auth/cli-callback?code=ABC&state=XYZ`, confirm the page renders, "Copy" button copies `ABC`, no `Cache-Control: public` or `Server-Timing` leaks the code.

Acceptance: `bun --cwd apps/api run build` passes; `bun --cwd apps/api test` passes; manual smoke clean.

### Phase 2: File-backed session store  [DONE: api-me Wave 2, with a sharper shape]

Landed in commit `58a5e9b36` as `packages/auth/src/node/machine-tokens-store.ts` (the file was renamed from `machine-session-store.ts` during the api-me Wave 2 schema break). The persisted shape is `PersistedAuth = { grant, unlock }` per the api-me spec, not `OAuthSession`. The original task list below is preserved as a historical record; for the as-shipped contract, see `specs/20260514T200000-api-me-three-field-token-bundle.md`.

What landed:
- `loadMachineTokens({ filePath?, log? }) -> Result<PersistedAuth | null, MachineAuthStorageError>`
- `saveMachineTokens(value: PersistedAuth | null, { filePath? }) -> Result<undefined, MachineAuthStorageError>`
- Atomic rename, mode 0o600, parent dir 0o700, corrupt-blob → `Ok(null)` + warn.
- No `Bun.secrets` references remain in `packages/auth`.

- [x] **2.1** Rewrite `packages/auth/src/node/machine-session-store.ts` end-to-end (keep the file name; it still persists the full `OAuthSession`, not just tokens). Remove every `Bun.secrets` import and reference. Remove the injectable `backend` parameter from the public API (tests inject a custom path instead). New module shape:
  ```ts
  import { OAuthSession } from '../auth-types.js';

  const DEFAULT_AUTH_FILE_PATH = path.join(os.homedir(), '.epicenter', 'auth.json');

  export async function loadMachineSession({
      filePath = DEFAULT_AUTH_FILE_PATH,
      log = createLogger('machine-session-store'),
  }: { filePath?: string; log?: Logger } = {}): Promise<Result<OAuthSession | null, MachineAuthStorageError>>;

  export async function saveMachineSession(
      session: OAuthSession | null,
      { filePath = DEFAULT_AUTH_FILE_PATH }: { filePath?: string } = {},
  ): Promise<Result<undefined, MachineAuthStorageError>>;
  ```
- [ ] **2.2** `saveMachineSession` semantics:
  - When `session === null`: `await fs.unlink(filePath)`; treat ENOENT as success.
  - Otherwise: ensure `path.dirname(filePath)` exists with `fs.mkdir(dir, { recursive: true, mode: 0o700 })`; write to `${filePath}.tmp` with `fs.writeFile(tmp, JSON.stringify(OAuthSession.assert(session)), { mode: 0o600 })`; `fs.rename(tmp, filePath)`. Atomic-rename pattern so a crash mid-write never leaves a half-written file.
- [ ] **2.3** `loadMachineSession` semantics:
  - `fs.readFile(filePath, 'utf-8')`. ENOENT -> `Ok(null)`.
  - Other I/O errors -> `Err(StorageFailed)`.
  - JSON parse failure or `OAuthSession.assert` failure -> log a warning, treat as `Ok(null)` (corrupt blob is signed-out, same as the current keychain path).
  - Optional: on Unix, check `fs.stat(filePath).mode & 0o077`; if non-zero (group/world readable), refuse to load and tell the user to `chmod 600 ~/.epicenter/auth.json`. This is a paranoia layer; gcloud/aws do not enforce it. Decision: include the check, refuse to load, print a one-line remediation. Cost is ~6 lines; benefit is real for users who accidentally `cp -r ~/` to a sharing host.
- [ ] **2.4** Tests in `packages/auth/src/node/machine-session-store.test.ts`:
  - Round trip: write then read returns the same `OAuthSession` (tokens + identity).
  - File mode: written file has mode `0o600`.
  - Directory: created with mode `0o700` if missing.
  - Null: `saveMachineSession(null)` removes the file; subsequent `load` returns `Ok(null)`.
  - Missing: `load` against a non-existent path returns `Ok(null)`.
  - Corrupt: write `{not valid json` directly to the path; `load` returns `Ok(null)` and logs a warning.
  - Schema-mismatch: write a valid JSON object that lacks the `identity` field; `load` returns `Ok(null)` and logs a warning (treat as signed-out; user re-logs in to populate identity).
  - Atomic: simulate a write that throws after writing the `.tmp` (e.g. inject a fake `fs.rename` that throws). The original `auth.json` (if present before the write) remains intact.
  - Permission-too-open: pre-write the file with mode `0o644` and assert `load` refuses with a clear error.
  Use `Bun.tmpdir()` for `filePath` in every test so nothing touches `~/.epicenter`.

Acceptance: `bun --cwd packages/auth test machine-session-store` passes; the test suite does not require `Bun.secrets` or any keyring availability.

### Phase 3: OOB launcher  [OPEN]

`packages/auth/src/node/oob-launcher.ts` does not exist yet. The launcher returns an `OAuthTokenGrant` (3 fields per api-me spec). The caller (`machine-auth.ts`, Phase 4) is responsible for pairing the grant with a `GET /api/me` call to construct the `unlock` section of `PersistedAuth`. The launcher itself is concerned only with the OAuth dance.

- [ ] **3.1** Add `packages/auth/src/node/oob-launcher.ts`:
  ```ts
  export function createOobOAuthLauncher({
      baseURL = EPICENTER_API_URL,
      clientId,
      scopes = ['openid', 'profile', 'email', 'offline_access', 'workspaces:open'],
      redirectUri,                   // matches the registered URI
      openBrowser = defaultOpenBrowser,
      readCode = defaultReadCode,
      print = console.log,
      fetch = globalThis.fetch,
      crypto = globalThis.crypto,
  }: CreateOobLauncherConfig): OAuthSignInLauncher;
  ```
- [ ] **3.2** Implementation, in order:
  1. `code_verifier`: 32 bytes from `crypto.getRandomValues`, base64url-encoded, padding stripped.
  2. `code_challenge`: `base64url(SHA-256(code_verifier))` via `crypto.subtle.digest`.
  3. `state`: 16 bytes from `crypto.getRandomValues`, base64url.
  4. Build `URL`; assemble query params with `URLSearchParams`.
  5. `print(URL)` and a short instruction line.
  6. `openBrowser(url)` best-effort (`Bun.spawn(['open' | 'xdg-open' | 'start', url])`); ignore failures.
  7. `readCode()` reads one trimmed line from stdin via `process.stdin`.
  8. `POST ${baseURL}/auth/oauth2/token` with `URLSearchParams({ grant_type: 'authorization_code', code, code_verifier, client_id, redirect_uri, resource: baseURL })` and `content-type: application/x-www-form-urlencoded`.
  9. Validate `token_type` is `bearer` (case-insensitive), `access_token` is a string, `refresh_token` is a string, `expires_in` is a positive number.
  10. Return `Ok({ accessToken, refreshToken, accessTokenExpiresAt: now + expires_in * 1000 })`.
  11. On any step failure, return `Err(LauncherError)` with a `cause`.
- [ ] **3.3** Define errors using `defineErrors`:
  ```ts
  export const OobLauncherError = defineErrors({
      TokenExchangeFailed: ({ status, cause }) => ({ ... }),
      InvalidTokenResponse: ({ cause }) => ({ ... }),
      AuthorizationCancelled: () => ({ ... }),     // user pasted empty input or aborted
  });
  ```
- [ ] **3.4** Tests in `packages/auth/src/node/oob-launcher.test.ts`:
  - Happy path: stub `fetch` to return a canned token grant; stub `readCode` to return a fake code; assert the POST body shape (grant_type, code_verifier, client_id, redirect_uri, resource) and that the returned `OAuthTokenGrant` matches.
  - PKCE: assert `code_challenge` round-trips against the verifier sent on exchange (the launcher does not need to verify; the test computes `SHA-256(verifier)` and checks the URL it printed).
  - Invalid token response: `fetch` returns `{ token_type: 'mac' }`; assert `Err(InvalidTokenResponse)`.
  - Server error: `fetch` returns 400 with a JSON body; assert `Err(TokenExchangeFailed)` with the body in `cause`.
  - Empty input: `readCode` returns `""`; assert `Err(AuthorizationCancelled)`.

Acceptance: `bun --cwd packages/auth test oob-launcher` passes.

### Phase 4: Rewrite `machine-auth.ts`  [OPEN; currently stubbed]

This is the visible API surface for the CLI and daemons. Today the module is **stubbed** (every function throws `PENDING_WAVE_3`). The rewrite below adopts the as-shipped `PersistedAuth` shape, `loadMachineTokens` / `saveMachineTokens` (the renamed store from api-me Wave 2), and `/api/me` (the as-shipped identity endpoint from api-me Wave 1). The original draft below references `OAuthSession` and `machine-session-store`; treat as historical and substitute `PersistedAuth` and `machine-tokens-store` throughout when implementing.

The shape the rewrite must construct on sign-in:

```ts
const persisted: PersistedAuth = {
    grant: { accessToken, refreshToken, accessTokenExpiresAt },
    unlock: { userId: meResponse.user.id, encryptionKeys: meResponse.encryptionKeys },
};
// meResponse.user.email goes into in-memory profile, NOT into PersistedAuth.
```

`createOAuthAppAuth` already takes a `persistedAuthStorage` (not `sessionStorage`) parameter and handles the network gate (lazy `/api/me` verification on first `auth.fetch`). The CLI just plugs in the file-backed storage and the OOB launcher.

- [ ] **4.1** Replace the file. The new shape:
  ```ts
  // packages/auth/src/node/machine-auth.ts
  import { OAuthSession } from '../auth-types.js';
  import { createOAuthAppAuth } from '../create-oauth-app-auth.js';
  import { createOobOAuthLauncher } from './oob-launcher.js';
  import {
      loadMachineSession,
      saveMachineSession,
  } from './machine-session-store.js';

  export async function loginWithOob({
      baseURL = EPICENTER_API_URL,
      clientId = EPICENTER_CLI_OAUTH_CLIENT_ID,
      redirectUri = `${EPICENTER_API_URL}/auth/cli-callback`,
      filePath,                     // optional override; defaults inside the store
      fetch,
      log = createLogger('machine-auth'),
      print,
      openBrowser,
      readCode,
  }: { ... } = {}): Promise<Result<{ identity: WorkspaceIdentity }, ...>> {
      const launcher = createOobOAuthLauncher({
          baseURL, clientId, redirectUri,
          openBrowser, readCode, print, fetch,
      });
      let currentSession: OAuthSession | null = null;
      const auth = createOAuthAppAuth({
          baseURL,
          clientId,
          launcher,
          sessionStorage: {
              get: () => currentSession,
              set: async (next) => {
                  const { error } = await saveMachineSession(next, { filePath });
                  if (error) throw error;
                  currentSession = next;
              },
          },
          fetch,
      });
      const result = await auth.startSignIn();
      // startSignIn -> launcher returns token grant -> loadIdentity hits
      // /workspace-identity -> replaceSession persists the full OAuthSession
      if (result.error) return Err(result.error);
      if (!currentSession) return Err(/* unreachable invariant */);
      return Ok({ identity: currentSession.identity });
  }

  export async function status({
      filePath,
      log = createLogger('machine-auth'),
      fetch,
  } = {}): Promise<Result<...>> {
      const { data: session, error } = await loadMachineSession({ filePath, log });
      if (error) return Err(error);
      if (!session) return Ok({ status: 'signedOut' as const });
      // Verify the bearer is still live by hitting /workspace-identity (the
      // canonical identity endpoint; same endpoint the browser uses). On 200,
      // refresh the cached identity from the response. On network failure,
      // surface 'unverified' with the cached identity.
      const auth = await createMachineAuthClient({ filePath, fetch, log });
      const response = await auth.fetch('/workspace-identity');
      if (response.status === 200) return Ok({ status: 'valid', identity: session.identity });
      return Ok({ status: 'unverified', identity: session.identity });
  }

  export async function logout({ filePath, fetch, log = createLogger('machine-auth') } = {}) {
      const { data: session, error } = await loadMachineSession({ filePath, log });
      if (error) return Err(error);
      if (!session) return Ok({ status: 'signedOut' as const });
      const auth = await createMachineAuthClient({ filePath, fetch, log });
      await auth.signOut();   // revokes via /auth/oauth2/revoke and clears the file
      return Ok({ status: 'loggedOut' as const });
  }

  export async function createMachineAuthClient({
      filePath,
      fetch,
      log = createLogger('machine-auth'),
      now,
  } = {}): Promise<AuthClient> {
      const { data: loaded, error } = await loadMachineSession({ filePath, log });
      if (error) throw error;
      if (!loaded) {
          throw new Error(
              '[machine-auth] no saved session at ~/.epicenter/auth.json. ' +
              'Run `epicenter auth login` first.',
          );
      }
      let currentSession: OAuthSession | null = loaded;
      return createOAuthAppAuth({
          baseURL: EPICENTER_API_URL,
          clientId: EPICENTER_CLI_OAUTH_CLIENT_ID,
          // Daemons never spawn an interactive launcher; re-login is always
          // a human running `epicenter auth login`.
          launcher: { startSignIn: async () => Ok(null) },
          sessionStorage: {
              get: () => currentSession,
              set: async (next) => {
                  const { error } = await saveMachineSession(next, { filePath });
                  if (error) throw error;
                  currentSession = next;
              },
          },
          ...(fetch ? { fetch } : {}),
          ...(now ? { now } : {}),
      });
  }
  ```
- [ ] **4.2** Delete `DeviceTokenError`, `MachineAuthClient` (type alias for the Better Auth client), `pollForAccessToken`, `fetchOAuthSession`, `readRecord`, `readString`, `readPositiveNumber`, and the entire module-level `createAuthClient({ plugins: [deviceAuthorizationClient()] })` setup. Drop the `better-auth/client/plugins` import.
- [ ] **4.3** Update `packages/auth/src/node.ts` re-exports: remove `DeviceTokenError`, add `loginWithOob` (and the `loginWithDeviceCode` name disappears entirely; no deprecation alias).
- [ ] **4.4** Update `packages/cli/src/commands/auth.ts` to call `loginWithOob` instead of `loginWithDeviceCode`. The CLI flow is now:
  ```ts
  // CLI calls loginWithOob({ print: (line) => console.log(line) })
  // Launcher prints URL, reads stdin, exchanges, persists. CLI just reports
  // the identity (user email) on success.
  ```
- [ ] **4.5** Rewrite `packages/auth/src/node/machine-auth.test.ts` from scratch:
  - `loginWithOob` happy path: stub `openBrowser`, `readCode`, and `fetch` (the launcher's `/oauth2/token` POST returns a canned `{ access_token, refresh_token, expires_in, token_type }`; the subsequent `loadIdentity` GET to `/workspace-identity` returns canned `{ user, encryptionKeys }`); assert the `OAuthSession` written to a tmpfile contains both nested fields, and the returned identity matches the canned response.
  - `loginWithOob` cancellation: `readCode` returns empty; assert no file is written.
  - `loginWithOob` workspace-identity 401: stub the token endpoint to succeed but `/workspace-identity` returns 401; assert `Err` (sign-in failed at identity step) and no file written.
  - `status` valid: pre-write an `OAuthSession`; stub `fetch` to return 200 on `/workspace-identity`; assert `{ status: 'valid', identity: <persisted> }`.
  - `status` unverified: pre-write an `OAuthSession`; stub `fetch` to return 503; assert `{ status: 'unverified', identity: <persisted> }` (cached identity is still usable; the network only confirms bearer liveness).
  - `status` signed-out: no file present; assert `{ status: 'signedOut' }`.
  - `logout` revokes and clears: pre-write a session; stub `fetch` to capture the revoke POST; assert the body shape (`token`, `token_type_hint: 'refresh_token'`, `client_id`) and that the file is gone.
  - `logout` survives revoke failure: stub `fetch` for revoke to return 503; assert the file is still deleted and the result is `{ status: 'loggedOut' }`.
  - `createMachineAuthClient`: reauth-required-on-save-failure invariant retained (the new file backend can fail by injecting a read-only directory).

Acceptance: `bun --cwd packages/auth test` passes; `bun --cwd packages/cli typecheck` passes.

### Phase 5: Tab-Manager-style consumers (audit only; no deletions in this spec)

The other CLI / daemon consumers of `createMachineAuthClient` are:

```txt
apps/fuji/blocks/daemon-route.ts:48
apps/honeycrisp/blocks/daemon-route.ts:29
apps/opensidian/blocks/daemon-route.ts:29
apps/zhongwen/blocks/daemon-route.ts:29
apps/honeycrisp/blocks/script.ts:31
apps/opensidian/blocks/script.ts:31
apps/zhongwen/blocks/script.ts:31
playground/tab-manager-e2e/epicenter.config.ts:48
playground/opensidian-e2e/epicenter.config.ts:65
examples/notes-cross-peer/notes.ts:47
```

These do not change in this spec because their import shape (`createMachineAuthClient`) is unchanged. The `apps/*/blocks/script.ts` divergence from the Fuji rule (script.ts is a thin snapshot reader + IPC actions client) is a separate concern tracked in a follow-up spec; do not bundle it here.

- [ ] **5.1** Smoke each daemon entrypoint after Phase 4 lands: `bun --cwd apps/fuji run daemon` (etc.) confirms the daemon loads `~/.epicenter/auth.json` and reaches `/workspace-identity` successfully.
- [ ] **5.2** No code change in this phase. This is verification that the contract preservation held.

### Phase 6: Documentation

- [ ] **6.1** `docs/encryption.md`: remove any remaining `/auth/get-session` references. Replace with `/workspace-identity` as the single identity source.
- [ ] **6.2** Add a section to `packages/cli/README.md` (or create it):
  ```md
  ## Authentication

  `epicenter auth login` prints a URL, you sign in on the hosted portal, and
  paste the displayed code back into the terminal. The refresh token lives at
  `~/.epicenter/auth.json` with file mode 0o600. This is the same shape as
  `~/.aws/credentials` and `~/.codex/auth.json`.

  Sign out with `epicenter auth login` -- this calls `/auth/oauth2/revoke` and
  deletes the file.

  Project-local `.epicenter/` directories hold daemon runtime state (sockets,
  PIDs, logs) and never contain credentials.
  ```
- [ ] **6.3** Update `specs/20260512T111335-post-oauth-audit-remediation.md`: in the Phase 4 section, prepend a "Superseded by 20260514T120000-machine-auth-oob-clean-break.md" notice and link.
- [ ] **6.4** Add a JSDoc note on `EPICENTER_CLI_OAUTH_CLIENT_ID` in `packages/constants/src/oauth.ts` describing the OOB flow and the canonical redirect URI.

## Out of Scope

- **OS keychain support of any kind.** Decided against in Design Decisions. If a future user makes a credible case for it, they can wrap the file with a per-platform helper; we do not ship the abstraction.
- **Personal access tokens.** Different product surface; tracked separately if needed.
- **Loopback PKCE.** Withdrawn from the prior recommendation. Adds a localhost listener with no reliability gain over OOB paste.
- **Device authorization grant.** Adding a Better Auth plugin and a `/device` page is server-side surface area we do not need.
- **`script.ts` cleanup across honeycrisp/opensidian/zhongwen.** Real but separate.
- **Refresh token reuse detection (RTD).** Better Auth rotates refresh tokens; RTD enforcement is plugin-side work tracked under server hardening.
- **Multi-account.** One signed-in identity per machine. `auth.json` does not need to be a list. If multi-account becomes a requirement, the file can grow a `current` pointer and a `users` map without breaking the schema.

## Edge Cases

### User pastes a malformed code

The launcher's `POST /oauth2/token` returns 400 with `error: invalid_grant`. `TokenExchangeFailed` propagates. CLI prints "The code you pasted was rejected by the server. Run `epicenter auth login` again." No file is written.

### User opens the URL on a different device (phone, colleague's laptop)

This is the explicit unlock for headless servers. The redirect lands on `https://api.epicenter.so/auth/cli-callback?code=...` on whatever browser the user used. They copy the displayed code, type it into the terminal session running on the headless box. Works.

### User runs `auth login` in a CI pipeline

CI provides the code via stdin redirection or environment-variable-fed input. The flow does not require interactivity beyond stdin. (For fully unattended CI, a future PAT system is the right answer; this spec does not block that future.)

### Two `epicenter auth login` invocations run concurrently

Each launcher generates its own `code_verifier` and `state`. Each writes to `~/.epicenter/auth.json` via atomic rename. The last writer wins; whichever access token is in the file is valid. Refresh-token rotation on the next API call will invalidate the loser's token. No file corruption.

### File permissions get too permissive

If the file is `0o644` (or worse), `loadMachineSession` refuses to load and prints `chmod 0o600 ~/.epicenter/auth.json`. The user fixes it once. Subsequent loads pass.

### `~/.epicenter` exists but is owned by another user (multi-user host)

`fs.mkdir(dir, { recursive: true, mode: 0o700 })` succeeds because the directory exists; writing the file fails with EACCES. The user gets a clear filesystem error pointing at the path. No silent fallback to `/tmp`.

### Refresh token expires (>30 days idle)

The daemon's first authenticated request after expiry returns 401 from `/auth/oauth2/token` refresh. `createOAuthAppAuth` enters `reauth-required` (existing behavior). The user re-runs `epicenter auth login`. No code change.

### Token rotation race

`createOAuthAppAuth` already serializes refresh attempts with an in-flight `refreshPromise`. The file storage backend is single-writer per process; two daemon processes on the same machine for the same user are not supported (and were not supported under the keychain path either).

### Server's TLS certificate changes mid-flight

The CLI's `fetch` validates TLS. A mid-flight cert rotation that breaks validation surfaces as a fetch error from `node:tls`. `TokenExchangeFailed` carries it as `cause`.

### Cloudflare Page Rule contradicts the response header

If an operator sets `Cache Everything` on `/auth/cli-callback` via the Cloudflare dashboard, our `no-store, no-transform` header is honored by Workers but the page may still be cached on the edge depending on Cloudflare's interpretation. Mitigation: document this in the deploy runbook, and on first deploy confirm via curl that the response has `cf-cache-status: BYPASS` or `DYNAMIC`.

## Verification Plan

### Unit and integration

```bash
bun --cwd packages/auth test
bun --cwd apps/api test
bun --cwd packages/cli typecheck
bun --cwd apps/api run build
```

Required coverage:

- `packages/auth/src/node/machine-session-store.test.ts`: round trip, file mode, atomic rename, corrupt blob, permissions check (all listed in Phase 2.4).
- `packages/auth/src/node/oob-launcher.test.ts`: happy path, PKCE shape, invalid token response, server error, cancellation (Phase 3.4).
- `packages/auth/src/node/machine-auth.test.ts`: login / status / logout / createMachineAuthClient (Phase 4.5).
- `apps/api`: no new tests required; existing `oauth-principal.test.ts` and `workspace-identity.test.ts` continue to cover the resource boundary. Add one snapshot/integration test that GETs `/auth/cli-callback?code=ABC` and asserts the rendered HTML contains `ABC` inside a `<code>` tag.

### Manual smoke

```txt
Dev API (bun --cwd apps/api dev):
  1. rm -f ~/.epicenter/auth.json
  2. epicenter auth login
     - prints authorize URL
     - opens browser (best-effort)
     - browser hits /sign-in -> /consent (skipped) -> /auth/cli-callback
     - page renders code in monospace block, Copy button works
     - paste into terminal
     - "Signed in as user@example.com"
  3. stat -f "%Lp" ~/.epicenter/auth.json    # macOS, or `stat -c '%a' ~/.epicenter/auth.json` on Linux
     -> 600
  4. epicenter auth status
     -> "Signed in (verified)"
  5. chmod 644 ~/.epicenter/auth.json && epicenter auth status
     -> refuses with "chmod 600" message
  6. chmod 600 ~/.epicenter/auth.json
  7. epicenter auth logout
     -> network call to /auth/oauth2/revoke seen in apps/api logs
     -> file deleted
  8. epicenter auth status
     -> "Signed out"

Headless smoke (SSH from a host with no DISPLAY):
  1. ssh user@server
  2. epicenter auth login
  3. Copy the printed URL into your laptop browser
  4. Sign in there; copy the code from /auth/cli-callback
  5. Paste back into the SSH session
  6. Login succeeds
  7. ~/.epicenter/auth.json on the server has the session

Docker smoke:
  1. docker run -it --rm -v $HOME/.epicenter:/root/.epicenter epicenter-cli auth login
  2. Open the URL on the host; paste in container
  3. File persists in the host's ~/.epicenter via the bind mount
  4. Subsequent `docker run --rm -v $HOME/.epicenter:/root/.epicenter epicenter-fuji-daemon`
     loads the session and connects to apps/api

Cloudflare smoke (against a deployed apps/api):
  1. curl -i https://api.epicenter.so/auth/cli-callback?code=test
  2. Confirm response headers:
     - cache-control: no-store, no-transform
     - content-type: text/html; charset=UTF-8
     - x-content-type-options: nosniff (from secureHeaders)
     - x-frame-options: DENY (from secureHeaders)
     - referrer-policy: strict-origin-when-cross-origin (from secureHeaders)
     - cf-cache-status: BYPASS or DYNAMIC
  3. Confirm response body contains the literal string `test` inside a `<code>` tag and no Rocket-Loader-injected scripts.
```

## Grill Pass

Questions that must stay answered as implementation proceeds.

1. **Why OOB and not loopback?** Loopback adds a localhost listener (~100 lines, port-bind edge cases, browsers that block redirects to private addresses) for "auto close the tab" UX. OOB needs ~50 lines and works in every environment we ship to including headless and Docker. The product cost is one copy-paste step per login.
2. **Why file and not keychain?** macOS keychain ACLs gate by code signature, which only matters if the binary is signed. We do not ship a signed CLI. On Linux libsecret and Windows DPAPI the per-user kernel boundary is equivalent to `chmod 0o600`. Disk-at-rest protection in 2026 is provided by FileVault / BitLocker / LUKS at the OS layer. The keychain code is speculative complexity that hard-fails on the deployment environments that actually run the daemon.
3. **What stops a malicious same-user process from reading the file?** Nothing, and that has always been true of every CLI in the same threat tier (`gh`, `aws`, `gcloud`, `codex`). If that threat surface ever becomes load-bearing, the answer is a hardware-backed enclave (Secure Enclave / TPM), not the OS keychain.
4. **Why not Personal Access Tokens?** They contradict the "you just sign in" product promise. A PAT means the user manages a long-lived secret they can leak in git history. OAuth + refresh-token rotation is materially safer.
5. **What is the smallest piece of this spec that has to be true for it to ship?** Phases 1 through 4. Phases 5 and 6 are smoke and docs. If Phase 4 lands without Phase 6, the system works; the docs are stale.
6. **What is the easiest bug to miss?** Forgetting `Cache-Control: no-store` on the callback page. A cached auth code page lets a code be replayed within its (short) TTL, but until the user runs `epicenter auth login` again or the auth server expires it. Mitigation: smoke test #2 above, plus a snapshot test asserting the header.
7. **What is the highest-risk design choice?** Putting the callback page on the auth server itself. If Cloudflare Page Rules or worker config later transform that response, the code value could be mangled. Mitigation: `no-transform`, secureHeaders, and a curl-based smoke step in the deploy checklist.

## Open Questions

1. Should `loginWithOob` accept `--no-open-browser` to suppress the `Bun.spawn(['open', url])` call? Default: do not add the flag; the launcher prints the URL anyway. Reopen if user reports.
2. Should `/auth/cli-callback` accept arbitrary `client_id` values, or pin it to `epicenter-cli`? Pin: an HTML page rendering codes for unknown clients is a phishing surface. The page should refuse codes that did not originate from a request targeting `epicenter-cli`. Implementation: the Better Auth redirect URI is per-client; `/auth/cli-callback` is only listed on the `epicenter-cli` row, so Better Auth would not redirect any other client here. No additional server check needed; doc the invariant.
3. Should the dashboard expose a "revoke all sessions" action that hits the CLI's refresh token? Yes, eventually. Tracked in a sibling spec for `/api/sessions`.
4. Should the CLI prompt for re-auth automatically on `reauth-required`? No. The daemon entering `reauth-required` is the daemon's signal to wait; the human runs `epicenter auth login` explicitly.

## Next Implementation Prompt

```txt
Goal
  Land the server-side callback page and config changes (Phase 1 of
  20260514T120000-machine-auth-oob-clean-break.md) so a manual GET to
  /auth/cli-callback?code=ABC&state=XYZ renders the code on a styled page
  with no-store, no-transform, and the existing AuthLayout. No CLI changes
  in this prompt.

Files to add
  apps/api/src/auth-pages/cli-callback-page.tsx
    - Export CliCallbackPage taking { code, state, error, errorDescription }
    - Success branch: heading "Signed in to Epicenter CLI", monospace
      <code>{code}</code>, Copy button via inline script
      navigator.clipboard.writeText(code).
    - Error branch: heading "Sign-in failed", show error and
      errorDescription as text nodes.
    - Use AuthLayout.

  apps/api/src/auth-pages/scripts/cli-callback.ts
    - Inline script tag that wires the Copy button.
    - Same idiom as scripts/consent.ts (template literal exported as
      CLI_CALLBACK_SCRIPT).

Files to edit
  apps/api/src/auth-pages/index.tsx
    - Add renderCliCallbackPage(...) export mirroring renderConsentPage.

  apps/api/src/app.ts
    - Import secureHeaders from 'hono/secure-headers'.
    - Register app.get('/auth/cli-callback', secureHeaders(), handler).
    - Handler reads c.req.query('code'/'state'/'error'/'error_description'),
      sets Cache-Control: no-store, no-transform, returns c.html(
      renderCliCallbackPage({ ... })).
    - Place this route before app.on(['GET','POST'], '/auth/*', ...) for
      clarity; specificity wins regardless of order.

  packages/constants/src/oauth.ts
    - epicenter-cli entry: runtime: 'native',
      redirectUris: ['https://api.epicenter.so/auth/cli-callback'].
    - JSDoc on EPICENTER_CLI_OAUTH_CLIENT_ID: describe the OOB flow.

  apps/api/src/auth/trusted-oauth-clients.ts
    - Collapse toOAuthClientType to two-arm switch: browser/extension
      -> 'user-agent-based', native -> 'native'.

Acceptance
  - bun --cwd apps/api run build passes.
  - bun --cwd apps/api test passes.
  - Manual: GET http://localhost:8787/auth/cli-callback?code=test&state=xyz
    renders a page with the literal string `test` inside a <code> tag and
    Cache-Control: no-store, no-transform on the response.
  - Manual: GET .../auth/cli-callback?error=access_denied renders the error
    branch with `access_denied` displayed.
  - Manual: GET .../auth/cli-callback (no query) renders the missing-code
    error branch.

Out of scope for this prompt
  - Do not touch packages/auth (Phases 2-4 land separately).
  - Do not delete machine-auth.ts device-code code yet (Phase 4).
  - Do not deploy. Land the patch behind a normal PR.
```
