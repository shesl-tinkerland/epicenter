# Execute: OOB CLI Phases 3-4 (oob-launcher + machine-auth rewrite)

**Date**: 2026-05-14
**Type**: Execution spec for a coding agent
**Status**: Landed in PR #1762 (2026-05-15). All four waves shipped on `main`:
- Wave 1: `095ed0833 feat(auth): add OOB OAuth launcher for CLI sign-in`
- Wave 2: `51efc2853 feat(auth): replace machine-auth stub with OOB + /api/me flow`
- Wave 3: `3c5c875e2 feat(cli): wire epicenter auth to OOB flow`
- Wave 4: `f2f04c763 test(auth): cover OOB launcher and machine-auth flow`
- Follow-up: `6f15a2c72 fix(auth): clear sign-out before revoke`
**Drives**:
- `specs/20260514T120000-machine-auth-oob-clean-break.md` (Phases 3-4 only)
- `specs/20260514T200000-api-me-three-field-token-bundle.md` (PersistedAuth shape, grant/unlock split, network gate)
- `specs/20260514T210000-profile-as-application-data.md` (AuthState carries `unlock` only; email is fetched where displayed)

## What you are doing

Replace the stubbed `packages/auth/src/node/machine-auth.ts` with a working OOB
CLI auth implementation. When this lands, `epicenter auth login`, `status`, and
`logout` work end-to-end against the apps/api server, and the daemons under
`apps/*/blocks/daemon-route.ts` (currently broken) boot again.

This is the only thing standing between the current branch and a working CLI +
daemon plane. Phases 1-2 of the OOB CLI spec are already done (server callback
page, file-backed `machine-tokens-store.ts`). The `/api/me` spec landed all
four waves on `main`. You are completing what api-me explicitly says is
"out of scope" for that spec: the CLI surface itself.

## One Sentence

```
Write packages/auth/src/node/oob-launcher.ts (the OAuth dance), rewrite
packages/auth/src/node/machine-auth.ts (the public CLI/daemon surface),
update packages/cli/src/commands/auth.ts (docstring + function names),
add tests, and verify daemon boot.
```

## Required reading (in order, before any code change)

1. `specs/20260514T200000-api-me-three-field-token-bundle.md` end-to-end. This
   is the authoritative source for `PersistedAuth`, `/api/me` lifecycle, the
   network gate, and the same-user guard. **Where it conflicts with anything
   else, it wins.**

2. `specs/20260514T120000-machine-auth-oob-clean-break.md`: sections
   `## Status update (post-api-me)`, `## Desired State`, Phase 3, Phase 4. The
   rest is historical context.

3. `packages/auth/src/auth-types.ts`: exact arktype shapes of
   `OAuthTokenGrant` (3 fields), `LocalUnlockBundle`, `PersistedAuth`.

4. `packages/auth/src/auth-contract.ts`: `AuthClient` and `AuthState` contracts.

5. `packages/auth/src/create-oauth-app-auth.ts`: what `createMachineAuthClient`
   instantiates (for daemons). Pay attention to:
   - the `persistedAuthStorage` parameter shape
   - the `launcher.startSignIn` contract
   - the network gate / refresh-on-401 / same-user guard behavior
   - `auth.state.unlock` semantics (NOTE: per `profile-as-application-data`,
     `auth.state` carries only `status` + `unlock`; no `email`, no `profile`,
     no `profileStatus`. The CLI fetches `/api/me` itself for display.)

6. `packages/auth/src/node/machine-tokens-store.ts`: `loadMachineTokens` /
   `saveMachineTokens` signatures; the storage adapter you wire in.

7. `packages/auth/src/node/machine-auth.ts`: the stub you are replacing.
   Preserves public function names; daemon code imports them.

8. `packages/cli/src/commands/auth.ts`: the CLI surface to update.

9. `packages/constants/src/oauth.ts`: `EPICENTER_CLI_OAUTH_CLIENT_ID` and the
   registered redirect URI (`https://api.epicenter.so/auth/cli-callback`).

10. `apps/api/src/app.ts` (search for `/api/me` and `/auth/oauth2/*`): confirm
    the endpoint paths. **No edits.**

After reading, post a one-line acknowledgment of what you're about to do.

## State of the world

Already on `main`:

```
apps/api/src/app.ts                            /auth/cli-callback page
                                                /api/me + /api/health routes
apps/api/src/auth-pages/cli-callback-page.tsx  callback page renders code
packages/constants/src/oauth.ts                 epicenter-cli is runtime: 'native'
packages/auth/src/auth-types.ts                 PersistedAuth, OAuthTokenGrant,
                                                LocalUnlockBundle arktypes
packages/auth/src/create-oauth-app-auth.ts      persistedAuthStorage param,
                                                fetchProfile, network gate
packages/auth/src/node/machine-tokens-store.ts  file-backed PersistedAuth store
```

Stubbed (your work):

```
packages/auth/src/node/machine-auth.ts          throws PENDING_WAVE_3
packages/auth/src/node/oob-launcher.ts          does not exist
packages/cli/src/commands/auth.ts               stale docstring; uses removed name
```

## Implementation plan

Four commits. Each must leave `bun --cwd packages/auth typecheck` passing.

### Wave 1: oob-launcher

File: `packages/auth/src/node/oob-launcher.ts`

Public surface:

```ts
import type { Result } from 'wellcrafted/result';
import type { OAuthTokenGrant } from '../auth-types.js';

export type OAuthSignInLauncher = {
  startSignIn(): Promise<Result<OAuthTokenGrant | null, unknown>>;
};

export function createOobOAuthLauncher(config: {
  baseURL?: string;
  clientId: string;
  redirectUri?: string;
  scopes?: readonly string[];
  openBrowser?: (url: string) => Promise<void> | void;
  readCode?: () => Promise<string>;
  print?: (line: string) => void;
  fetch?: typeof globalThis.fetch;
  crypto?: Crypto;
  now?: () => number;
}): OAuthSignInLauncher;

export const OobLauncherError = defineErrors({
  TokenExchangeFailed: ({ status, body, cause }: ...) => ({ ... }),
  InvalidTokenResponse: ({ cause }: ...) => ({ ... }),
  AuthorizationCancelled: () => ({ message: 'No code pasted. Cancelled.' }),
});
```

Defaults:
- `baseURL` → `EPICENTER_API_URL` from `@epicenter/constants/apps`
- `redirectUri` → `${baseURL}/auth/cli-callback`
- `scopes` → `['openid', 'profile', 'email', 'offline_access', 'workspaces:open']`
- `openBrowser` → `Bun.spawn` against `open` (macOS), `xdg-open` (Linux), or
  `start` (Windows); swallow failures (best-effort)
- `readCode` → one trimmed line from `process.stdin` via `node:readline`
- `print` → `console.log`
- `fetch`, `crypto`, `now` → globals

Implementation order inside `startSignIn`:
1. Generate `code_verifier`: 32 bytes from `crypto.getRandomValues`, base64url
   (`+/=` stripped per RFC 7636).
2. Generate `code_challenge`: `base64url(SHA-256(code_verifier))` via
   `crypto.subtle.digest('SHA-256', ...)`.
3. Generate `state`: 16 bytes from `crypto.getRandomValues`, base64url.
4. Build authorize URL with `URL` + `URLSearchParams`:
   - `response_type=code`
   - `client_id`, `redirect_uri`, `scope` (space-joined), `state`
   - `code_challenge`, `code_challenge_method=S256`
   - `resource=${baseURL}`
5. `print(url)` on its own line, then a short instruction.
6. `openBrowser(url)` best-effort (try/catch + ignore).
7. `readCode()` → trimmed line. Empty → `Err(AuthorizationCancelled)`. Do not
   echo the code.
8. `POST ${baseURL}/auth/oauth2/token`:
   - `content-type: application/x-www-form-urlencoded`
   - `credentials: 'omit'`
   - body: `URLSearchParams({ grant_type: 'authorization_code', code,
     code_verifier, client_id, redirect_uri, resource: baseURL })`
9. Validate response:
   - non-2xx → `Err(TokenExchangeFailed)` with status + body text
   - `token_type !== 'bearer'` (case-insensitive) → `Err(InvalidTokenResponse)`
   - `access_token` / `refresh_token` not strings → `Err(InvalidTokenResponse)`
   - `expires_in` not finite positive number → `Err(InvalidTokenResponse)`
10. Return `Ok<OAuthTokenGrant>({ accessToken, refreshToken,
    accessTokenExpiresAt: now() + expires_in * 1000 })`.

Tests: `packages/auth/src/node/oob-launcher.test.ts`. See `## Tests` below.

Commit message: `feat(auth): add OOB OAuth launcher for CLI sign-in`.

### Wave 2: machine-auth rewrite

File: `packages/auth/src/node/machine-auth.ts` (REPLACE the stub end-to-end).

Public surface (preserve the function names; daemons import them):

```ts
export async function loginWithOob(config?): Promise<Result<{
  identity: { user: { id: string; email: string }; encryptionKeys: EncryptionKeys };
}, ...>>;

export async function status(config?): Promise<Result<
  | { status: 'signedOut' }
  | { status: 'valid';      identity: WorkspaceIdentity }
  | { status: 'unverified'; identity: WorkspaceIdentity },
  ...
>>;

export async function logout(config?): Promise<Result<
  | { status: 'signedOut' }
  | { status: 'loggedOut' },
  ...
>>;

export async function createMachineAuthClient(config?): Promise<AuthClient>;
```

`loadMachineSession` / `saveMachineSession` / `loginWithDeviceCode` /
`DeviceTokenError` / `MachineAuthClient` (Better Auth client alias) are all
**deleted**. No deprecation aliases. The single re-export module is
`packages/auth/src/node.ts`; update it to drop the removed names and add
`loginWithOob`.

Implementation details:

**Important shape note.** Per `specs/20260514T210000-profile-as-application-data.md`, `AuthState` carries `unlock` only (no `email`, no `profile`, no `profileStatus`). Email lives at the query layer for surfaces that display it. The CLI is such a surface, so `loginWithOob` and `status` must fetch `/api/me` themselves to get the email for display; they do not read it from `auth.state`.

```ts
// loginWithOob: run the OOB launcher, fetch /api/me with the new bearer,
// build PersistedAuth, persist atomically, return identity for display.
async function loginWithOob({
  baseURL = EPICENTER_API_URL,
  clientId = EPICENTER_CLI_OAUTH_CLIENT_ID,
  redirectUri = `${baseURL}/auth/cli-callback`,
  filePath,
  fetch = globalThis.fetch,
  log = createLogger('machine-auth'),
  print, openBrowser, readCode,
  now = Date.now,
} = {}) {
  const launcher = createOobOAuthLauncher({
    baseURL, clientId, redirectUri, fetch,
    openBrowser, readCode, print, now,
  });

  // Step 1: OAuth dance returns OAuthTokenGrant.
  const grantResult = await launcher.startSignIn();
  if (grantResult.error) return Err(grantResult.error);
  if (!grantResult.data) {
    return Err(MachineAuthRequestError.RequestFailed({
      cause: new Error('launcher returned no grant'),
    }));
  }
  const grant = grantResult.data;

  // Step 2: GET /api/me with the new bearer to load unlock + email.
  const meResponse = await fetch(`${baseURL}/api/me`, {
    headers: { Authorization: `Bearer ${grant.accessToken}` },
    credentials: 'omit',
  });
  if (meResponse.status !== 200) {
    return Err(MachineAuthRequestError.RequestFailed({
      cause: new Error(`/api/me returned ${meResponse.status}`),
    }));
  }
  const me = await meResponse.json();
  // Expected shape: { user: { id, email }, encryptionKeys }

  // Step 3: Build PersistedAuth and persist atomically.
  const cell: PersistedAuth = {
    grant,
    unlock: { userId: me.user.id, encryptionKeys: me.encryptionKeys },
  };
  const { error: saveError } = await saveMachineTokens(cell, { filePath });
  if (saveError) return Err(saveError);

  // Step 4: Return identity for the CLI to display. Email is not persisted;
  // it is returned by value here so the CLI can print "Signed in as <email>"
  // without having to refetch.
  return Ok({
    identity: {
      user: { id: me.user.id, email: me.user.email },
      encryptionKeys: me.encryptionKeys,
    },
  });
}
```

Note: this `loginWithOob` does NOT go through `createOAuthAppAuth`. The auth client factory is for daemons (long-lived; needs refresh + network gate); the CLI's login command runs once, persists, and exits. Using the factory for login would be circuitous (it would call the launcher and then internally call /api/me, but the CLI also needs the email out, so we'd still call /api/me twice or read from a removed `state.email` field).

```ts
// status: load cell; verify with a /api/me probe through createMachineAuthClient
// (so refresh-on-401 fires automatically); decode email from the /api/me response.
async function status({ filePath, fetch, log, now } = {}) {
  const { data: cell, error } = await loadMachineTokens({ filePath, log });
  if (error) return Err(error);
  if (!cell) return Ok({ status: 'signedOut' as const });

  const auth = await createMachineAuthClient({ filePath, fetch, log, now });
  const response = await auth.fetch('/api/me');
  if (response.status === 200) {
    const me = await response.json();
    return Ok({
      status: 'valid' as const,
      identity: {
        user: { id: me.user.id, email: me.user.email },
        encryptionKeys: me.encryptionKeys,
      },
    });
  }
  // Network failure, 401 with revoked refresh, etc. Cell may still be valid for
  // local decrypt. Surface the cached unlock; email is unknown without /api/me,
  // so leave it empty and let the CLI print "Account" or similar.
  return Ok({
    status: 'unverified' as const,
    identity: {
      user: { id: cell.unlock.userId, email: '' },
      encryptionKeys: cell.unlock.encryptionKeys,
    },
  });
}
```

```ts
// logout: revoke + clear via auth.signOut.
async function logout({ filePath, fetch, log = createLogger('machine-auth') } = {}) {
  const { data: cell, error } = await loadMachineTokens({ filePath, log });
  if (error) return Err(error);
  if (!cell) return Ok({ status: 'signedOut' as const });

  const auth = await createMachineAuthClient({ filePath, fetch, log });
  await auth.signOut();  // revokes refresh token; calls
                         // persistedAuthStorage.set(null) which unlinks the file
  return Ok({ status: 'loggedOut' as const });
}
```

Verify `auth.signOut`'s actual behavior in `create-oauth-app-auth.ts`. If it
swallows revoke failures and still clears the cell, you're done. If not, wrap
in a try/finally that always clears the file.

```ts
// createMachineAuthClient: load + construct, no launcher.
async function createMachineAuthClient({
  filePath, fetch, log = createLogger('machine-auth'), now,
} = {}): Promise<AuthClient> {
  const { data: loaded, error } = await loadMachineTokens({ filePath, log });
  if (error) throw error;
  if (!loaded) {
    throw new Error(
      '[machine-auth] no saved session at ~/.epicenter/auth.json. ' +
      'Run `epicenter auth login` first.',
    );
  }
  let currentCell: PersistedAuth | null = loaded;
  return createOAuthAppAuth({
    baseURL: EPICENTER_API_URL,
    clientId: EPICENTER_CLI_OAUTH_CLIENT_ID,
    launcher: { startSignIn: async () => Ok(null) },  // daemons don't interactively sign in
    persistedAuthStorage: {
      get: () => currentCell,
      set: async (next) => {
        const { error } = await saveMachineTokens(next, { filePath });
        if (error) throw error;
        currentCell = next;
      },
    },
    ...(fetch ? { fetch } : {}),
    ...(now ? { now } : {}),
  });
}
```

Keep `MachineAuthRequestError.RequestFailed` (still used by error wrapping).

Tests: rewrite `packages/auth/src/node/machine-auth.test.ts` from scratch. See
`## Tests` below.

Commit message: `feat(auth): replace machine-auth stub with OOB + /api/me flow`.

### Wave 3: CLI command + barrel exports

File: `packages/auth/src/node.ts`: drop `loginWithDeviceCode`, `DeviceTokenError`,
`MachineAuthClient` (alias) re-exports; add `loginWithOob`. Verify no callers
under `packages/` remain that import the deleted names.

File: `packages/cli/src/commands/auth.ts`:

1. Replace the top-of-file docstring. Remove "RFC 8628 device code flow" and
   "OS keychain" lines. Add a short paragraph:

   ```
   /**
    * `epicenter auth`: manage authentication with Epicenter.
    *
    * Uses an OOB (out-of-band) OAuth 2.1 authorization-code flow with PKCE.
    * `auth login` prints a URL; the user signs in on the hosted portal,
    * copies the one-time code from the success page, and pastes it into the
    * terminal. Tokens and the local-unlock bundle live at
    * `~/.epicenter/auth.json` with file mode 0o600.
    *
    * Same shape and same source as the browser, dashboard, and extension
    * clients (see specs/20260514T200000-api-me-three-field-token-bundle.md).
    */
   ```

2. `login` command: call `machineAuth.loginWithOob({ print: (line) =>
   console.log(line) })`. On success print `Signed in as
   ${identity.user.email}.` (or fall back to `Signed in.` when email is empty).

3. `status` and `logout`: unchanged shape, but they call the new functions and
   surface the new return shape (`{ status, identity }` not `{ status, session }`).

Commit message: `feat(cli): wire epicenter auth to OOB flow`.

### Wave 4: tests

Three test files. Use `path.join(os.tmpdir(), \`epicenter-test-\${randomUUID()}.json\`)`
for any file paths; tests must not touch `~/.epicenter`.

See `## Tests` below for the complete list. Run with:

```bash
bun --cwd packages/auth test
bun --cwd packages/cli typecheck
bun --cwd apps/api run build   # sanity; no server changes
```

Commit message: `test(auth): cover OOB launcher and machine-auth flow`.

## Tests

### `packages/auth/src/node/oob-launcher.test.ts`

```
test('happy path returns a 3-field OAuthTokenGrant')
  - stub openBrowser, readCode -> 'CODE123', fetch -> 200 with
    { access_token: 'a', refresh_token: 'r',
      expires_in: 3600, token_type: 'bearer' }
  - assert returned grant === { accessToken: 'a', refreshToken: 'r',
    accessTokenExpiresAt: now + 3_600_000 }
  - assert POST body URLSearchParams shape (grant_type, code='CODE123',
    code_verifier present, client_id, redirect_uri, resource)
  - assert openBrowser called with URL containing code_challenge =
    base64url(SHA-256(code_verifier))

test('PKCE verifier and challenge are linked')
  - record verifier from POST body
  - record challenge from URL printed
  - compute SHA-256(verifier) and base64url; assert equality with challenge

test('cancellation: empty paste returns Err(AuthorizationCancelled), no network')
  - readCode -> ''
  - assert fetch was NEVER called
  - assert result is Err(AuthorizationCancelled)

test('invalid token_type returns Err(InvalidTokenResponse)')
  - fetch returns 200 with token_type: 'mac'
  - assert Err(InvalidTokenResponse)

test('server 400 returns Err(TokenExchangeFailed) with status + body')
  - fetch returns 400 with { error: 'invalid_grant' }
  - assert Err(TokenExchangeFailed) carries status=400 and the body

test('openBrowser failure does not abort the flow')
  - openBrowser throws synchronously
  - readCode -> 'CODE'
  - fetch returns valid grant
  - assert Ok (best-effort browser open)

test('case-insensitive token_type check')
  - fetch returns token_type: 'Bearer'
  - assert Ok
```

### `packages/auth/src/node/machine-auth.test.ts`

Use `loadMachineTokens` to inspect file state in assertions. Stub `fetch` for
both `/auth/oauth2/token` (launcher) and `/api/me` (createOAuthAppAuth's
fetchProfile).

```
test('loginWithOob writes PersistedAuth and returns identity')
  - filePath = tmp; mock launcher fetch -> valid grant; mock /api/me ->
    { user: { id: 'u1', email: 'a@b.c' }, encryptionKeys: [{ version: 1, ... }] }
  - assert result.identity.user === { id: 'u1', email: 'a@b.c' }
  - assert file at filePath validates as PersistedAuth
  - assert file mode is 0o600

test('loginWithOob with empty paste writes no file')
  - readCode -> ''
  - assert no file at filePath after the call

test('loginWithOob with /api/me 401 returns Err and writes no file')
  - /oauth2/token succeeds; /api/me returns 401
  - assert Err
  - assert no file at filePath

test('status valid when /api/me returns 200 with same userId')
  - pre-write PersistedAuth via saveMachineTokens
  - mock /api/me -> 200 matching unlock.userId
  - assert { status: 'valid', identity }

test('status unverified on network failure preserves cell')
  - pre-write PersistedAuth
  - mock fetch to throw
  - assert { status: 'unverified', identity }
  - assert file still exists with same contents

test('status signedOut when no file')
  - no file at filePath
  - assert { status: 'signedOut' }

test('same-user guard wipes cell when /api/me returns different userId')
  - pre-write PersistedAuth with unlock.userId = 'alice'
  - mock /api/me -> 200 with user.id = 'bob'
  - call status
  - assert file is gone (createOAuthAppAuth's same-user guard fires)

test('logout revokes refresh token and deletes the file')
  - pre-write PersistedAuth
  - capture /auth/oauth2/revoke POST
  - assert body has token=<refreshToken>,
    token_type_hint='refresh_token', client_id='epicenter-cli'
  - assert file is deleted
  - assert result === { status: 'loggedOut' }

test('logout survives revoke failure and still deletes the file')
  - pre-write PersistedAuth
  - /auth/oauth2/revoke returns 503
  - assert file is still deleted
  - assert result === { status: 'loggedOut' }

test('createMachineAuthClient throws when no file')
  - no file
  - assert thrown error message mentions 'epicenter auth login'

test('createMachineAuthClient loads file and attaches Bearer after gate')
  - pre-write PersistedAuth
  - mock /api/me -> 200 (matching user)
  - mock GET /api/something -> 200 OK
  - call auth.fetch('/api/something')
  - assert request to /api/something has Authorization: Bearer header
  - assert /api/me was called before /api/something (network gate)
```

## Acceptance criteria

```
[ ] packages/auth/src/node/oob-launcher.ts exists; exports
    createOobOAuthLauncher and OobLauncherError
[ ] packages/auth/src/node/machine-auth.ts has no PENDING_WAVE_3 stubs;
    exports loginWithOob, status, logout, createMachineAuthClient
[ ] packages/auth/src/node.ts barrel: drops loginWithDeviceCode,
    DeviceTokenError, MachineAuthClient (alias); adds loginWithOob
[ ] packages/cli/src/commands/auth.ts: docstring describes OOB +
    auth.json (no device-code, no keychain mentions); `login` calls
    loginWithOob; `status`/`logout` consume the new return shape
[ ] grep across packages/* yields zero matches for:
    OAuthSession, loadMachineSession, saveMachineSession,
    machine-session-store, decodeIdTokenClaims, workspace_encryption_keys,
    loginWithDeviceCode, deviceAuthorizationClient
[ ] bun --cwd packages/auth test passes (new test files included)
[ ] bun --cwd packages/cli typecheck passes
[ ] bun --cwd apps/api run build passes (sanity; no server edits)
[ ] No new dependencies added to package.json
[ ] Each wave is a separate commit, in order; commits build sequentially
```

## Manual smoke (after merge, before declaring done)

Run apps/api at http://localhost:8787 with at least one OAuth client signed in
via a browser to populate the database.

```
1. rm -f ~/.epicenter/auth.json
2. epicenter auth login
   - Prints the authorize URL
   - Opens browser best-effort, or user copies the URL
   - Browser walks /sign-in -> /consent (skipped) -> /auth/cli-callback
   - Page renders the code in a monospace block with Copy button
   - User pastes into terminal
   - Terminal prints: "Signed in as <email>."
3. stat -c '%a' ~/.epicenter/auth.json    # Linux
   stat -f "%Lp" ~/.epicenter/auth.json   # macOS
   Expected: 600
4. epicenter auth status
   Expected: prints valid identity (email)
5. epicenter auth logout
   Expected: apps/api logs show POST /auth/oauth2/revoke;
             ~/.epicenter/auth.json is deleted
6. epicenter auth status
   Expected: signedOut
7. Boot a daemon (apps/fuji daemon entrypoint): expect it to load
   ~/.epicenter/auth.json, hit /api/me, and connect to /api/* successfully
```

## Out of scope (do NOT)

- Do NOT touch any file under `apps/api/`. Server work is done.
- Do NOT add OS keychain support, even behind an env flag.
- Do NOT add a `--no-browser` CLI flag.
- Do NOT introduce device authorization (RFC 8628) anywhere.
- Do NOT add id_token decoding, `customIdTokenClaims`, or JWT-claim parsing.
  The id_token is ignored if present in the `/oauth2/token` response.
- Do NOT bring back `OAuthSession`, `machine-session-store`, or
  `loadMachineSession` / `saveMachineSession` names.
- Do NOT add a multi-account `users` map. One identity per machine.
- Do NOT silently fall back to in-memory storage on file write failure.
  Surface the error to the caller.
- Do NOT modify `packages/auth/src/create-oauth-app-auth.ts`. The
  api-me spec is settled; your job is to plug into it, not redesign it.

## Grounding

The only external repo relevant to this work is `better-auth/better-auth`.
Facts verified during the OOB and api-me spec drafting (and baked into both
specs' research sections):

- `/oauth2/authorize` redirects to the registered `redirect_uri` with
  `?code&state` query params (RFC 6749 / OAuth 2.1).
- `/oauth2/token` accepts `grant_type=authorization_code` with PKCE; returns
  `{ access_token, refresh_token, token_type, expires_in }` (and optionally
  `id_token` when `openid` is granted; we ignore it).
- `/oauth2/revoke` is RFC 7009 compliant; revoking a refresh token
  invalidates access tokens issued from it.
- Claimed-HTTPS native redirect URIs are accepted for `type: 'native'`
  clients with exact match.

Reference: `node_modules/@better-auth/oauth-provider/dist/index.mjs:403-447`
(token endpoint), `:619-841` (introspect / revoke).

No Hono, Cloudflare, Yjs, Tauri, WXT, Drizzle, Turso, Svelte, libsignal,
Bitwarden, shadcn, TanStack, or Autumn knowledge is required.

## Process

1. Read all 10 files under `## Required reading` in order. Do not skim.
2. Post a one-line "I'm about to: ..." acknowledgment.
3. Wave 1: write `oob-launcher.ts`. Commit.
4. Wave 2: rewrite `machine-auth.ts`. Commit.
5. Wave 3: update CLI + barrel exports. Commit.
6. Wave 4: add the three test files. Commit.
7. Run the acceptance grep and bun commands. Fix anything that surfaces.
8. Run the manual smoke if the dev server is reachable.
9. Open a PR titled `feat(auth): OOB CLI flow + machine-auth.ts (OOB spec
   Phases 3-4)` summarizing the four commits.

If anything in the OOB CLI spec contradicts the api-me spec, the api-me spec
wins. If anything here contradicts either spec, prefer this execution doc as
written; both source specs were updated to reflect this plan.
