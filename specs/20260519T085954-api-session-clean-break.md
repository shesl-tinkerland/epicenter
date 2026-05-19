# API Session Clean Break

**Date**: 2026-05-19
**Status**: Implemented

## One Sentence

`/api/session` returns the current authenticated Epicenter session projection: the account user plus the local workspace identity needed to open encrypted local-first data.

## Overview

Rename `GET /api/me` to `GET /api/session` as a clean break. Keep one combined endpoint. Do not split profile and local workspace identity into separate HTTP calls unless the product later needs independent lifecycles.

This is an API meaning cleanup, not a protocol change. OAuth remains owned by Better Auth under `/auth/oauth2/*`; `/api/session` remains an OAuth-protected Epicenter resource endpoint.

## Motivation

### Current State

The API currently exposes one combined identity endpoint:

```txt
GET /api/me
  auth: cookie OR bearer
  bearer scope: workspaces:open
  response:
    user
    localIdentity
      subject
      keyring
```

The same route does several related jobs:

```txt
sign-in completion
  token grant -> /api/me -> persist localIdentity

cold-boot network gate
  persisted grant -> /api/me -> same-subject guard -> attach bearer

keyring refresh
  /api/me returns current localIdentity.keyring

profile lookup
  account popover can fetch /api/me for user.email
```

This creates a naming problem:

1. **`/api/me` sounds like profile data**: It is conventional, but it hides the fact that the endpoint releases keyring material.
2. **`/workspace-identity` was too narrow**: It described key release, but not the account projection or session verification role.
3. **Splitting endpoints would make naming cleaner but runtime worse**: The app needs the account and local identity together during sign-in and verification, so two endpoints would add failure modes and duplicate verification.

### Desired State

Use a route name that matches the combined concept:

```txt
GET /api/session
  returns:
    user
    localIdentity

  means:
    "Here is the current authenticated Epicenter session projection."
```

The route should be boring to explain:

```txt
OAuth proves the caller.
/api/session returns the app session projection.
localIdentity opens the local workspace.
```

## Research Findings

### Git History

The project has already tried the sharper workspace name.

```txt
2026-05-12  6634f527  /auth/me -> /workspace-identity
  rationale:
    named for its job
    not a profile endpoint

2026-05-12  a6469d11  require workspaces:open on /workspace-identity
  rationale:
    make it a scoped OAuth protected resource

2026-05-14  b76e1d40  spec chooses /api/me + 3-field token bundle
  rationale:
    avoid putting key material in id_token
    use conventional current-user REST endpoint

2026-05-14  9f32ea0  add /api/me, keep /workspace-identity as alias
  rationale:
    current-user endpoint under /api/*

2026-05-14  3b10602  delete /workspace-identity alias
  rationale:
    /api/me is sole identity endpoint

2026-05-15  15a157f  canonical ApiMeResponse + localIdentity vocabulary
  rationale:
    centralize the /api/me contract
```

Key finding: `/workspace-identity` was not forgotten. It was the right name for an earlier framing, then lost when the endpoint became the single current-user projection.

Implication: a clean break should not blindly revert. It should name the current combined role.

### OAuth And OIDC Boundary

Better Auth owns OAuth and OIDC protocol surfaces:

```txt
/auth/oauth2/authorize
/auth/oauth2/token
/auth/oauth2/revoke
/auth/oauth2/consent
/.well-known/openid-configuration
/.well-known/oauth-authorization-server/auth
/.well-known/oauth-protected-resource
```

Epicenter owns protected resource endpoints:

```txt
/api/session       proposed
/ai/*
/rooms/*
/api/billing/*
/api/assets/*
```

`/api/session` must not claim to be OAuth 2.1 or OIDC `userinfo`. It is an app resource protected by OAuth access tokens and Better Auth cookies.

### Expiry Naming

Keep `accessTokenExpiresAt`.

The OAuth token response uses `expires_in`, a relative lifetime in seconds. Epicenter converts that to an absolute JavaScript timestamp:

```ts
accessTokenExpiresAt = now() + expiresIn * 1000;
```

The better cleanup is documentation, not a rename:

```ts
/**
 * Absolute access-token expiry as epoch milliseconds.
 * Computed from OAuth expires_in seconds.
 * Used only as a transport refresh hint.
 */
accessTokenExpiresAt: number;
```

## Design Decisions

| Decision | Class | Choice | Rationale |
| --- | --- | --- | --- |
| Endpoint name | 2 coherence | `/api/session` | Names the combined current-user plus local-identity projection. |
| Split endpoint | 2 coherence | Do not split | The app needs `user` and `localIdentity` together for sign-in, network verification, and keyring refresh. |
| Compatibility alias | 2 coherence | No alias | Maximum clean break. One route means one mental model and one test matrix. |
| OAuth framing | 1 evidence | Keep OAuth under `/auth/oauth2/*` | Better Auth owns OAuth provider endpoints. `/api/session` is a protected resource endpoint. |
| OIDC userinfo | 2 coherence | Do not use for keyring | Keyring material is capability material, not a profile claim. |
| Response shape | 2 coherence | `{ user, localIdentity }` | The shape already matches the two things clients need. |
| Type name | 2 coherence | `ApiSessionResponse` | The current `ApiMeResponse` name bakes the old route into the public contract. |
| Expiry field | 1 evidence | Keep `accessTokenExpiresAt` | Repo convention uses `expiresAt` for absolute timestamps; add unit docs. |

## Rejected Alternatives

### Alternative A: Keep `/api/me`

```txt
Pros:
  conventional current-user endpoint
  no implementation churn
  already accepted in specs

Cons:
  undersells localIdentity.keyring
  sounds like profile or OIDC userinfo
  needs repeated explanation
```

Decision: reject for maximum clean break. Existing acceptance is not enough if the route name keeps requiring caveats.

### Alternative B: Rename To `/api/workspace-identity`

```txt
Pros:
  accurately names localIdentity
  makes keyring release obvious
  matches earlier route intent

Cons:
  names only half the response
  hides user/profile projection
  hides same-subject session verification
  revives an old framing the current design moved past
```

Decision: reject. The route is not only workspace identity.

### Alternative C: Split Into `/api/me` And `/api/workspace-identity`

```txt
GET /api/me
  -> user

GET /api/workspace-identity
  -> localIdentity
```

```txt
Pros:
  pure names
  profile callers do not touch keyring response
  localIdentity route is obviously sensitive

Cons:
  two network calls at sign-in or cold boot
  two caches
  two failure modes
  duplicated bearer verification
  unclear which call proves the persisted auth cell
  more code to preserve a conceptual split the runtime does not need
```

Decision: reject. This is the main asymmetric refusal. Refusing the split keeps the runtime single-flight and makes the network gate one decision.

### Alternative D: Put Keyring In OIDC `userinfo` Or `id_token`

```txt
Pros:
  uses named identity protocol surfaces
  fewer custom API names

Cons:
  keyring is capability material, not profile claim material
  id_tokens and userinfo payloads are more likely to be logged and inspected as identity data
  foreign verification does not matter because Epicenter is the only consumer
```

Decision: reject. Better Auth should continue to own OAuth/OIDC machinery; Epicenter should expose app capabilities through app endpoints.

## Architecture

### Layers

```txt
┌────────────────────────────────────────────────────────────┐
│ Better Auth OAuth Provider                                 │
│                                                            │
│ /auth/oauth2/authorize                                     │
│ /auth/oauth2/token                                         │
│ /auth/oauth2/revoke                                        │
│ /.well-known/*                                             │
└────────────────────────────────────────────────────────────┘
                         │ issues and verifies tokens
                         ▼
┌────────────────────────────────────────────────────────────┐
│ Epicenter API Resource Boundary                            │
│                                                            │
│ parse bearer                                               │
│ verify issuer, audience, signature, expiry                 │
│ require workspaces:open                                    │
│ load Better Auth user                                      │
└────────────────────────────────────────────────────────────┘
                         │ resolves caller
                         ▼
┌────────────────────────────────────────────────────────────┐
│ GET /api/session                                           │
│                                                            │
│ user                                                       │
│ localIdentity                                              │
│   subject                                                  │
│   keyring                                                  │
└────────────────────────────────────────────────────────────┘
                         │ boot payload
                         ▼
┌────────────────────────────────────────────────────────────┐
│ Client Auth Runtime                                        │
│                                                            │
│ PersistedAuth                                              │
│   grant                                                    │
│     accessToken                                            │
│     refreshToken                                           │
│     accessTokenExpiresAt                                   │
│   localIdentity                                            │
│     subject                                                │
│     keyring                                                │
└────────────────────────────────────────────────────────────┘
```

### One Call, Not Two

```txt
One combined endpoint:

  /api/session
    -> user
    -> localIdentity

  sign-in:
    token -> session -> persist

  cold boot:
    persisted cell -> session -> verify same subject -> attach bearer
```

```txt
Split endpoint:

  /api/me
    -> user

  /api/workspace-identity
    -> localIdentity

  sign-in:
    token -> me
          -> workspace-identity
          -> merge locally

  cold boot:
    persisted cell -> which endpoint proves same subject?
                   -> which endpoint refreshes keyring?
                   -> what if one succeeds and one fails?
```

The split has cleaner nouns but weaker runtime behavior.

## Proposed API Contract

### Route

```http
GET /api/session
Authorization: Bearer <access_token>
```

Cookie-authenticated first-party callers are also accepted through `requireUser`, matching the current `/api/me` behavior.

### Response

```ts
type ApiSessionResponse = {
  user: AuthUser;
  localIdentity: SubjectIdentity;
};
```

Expanded:

```ts
type ApiSessionResponse = {
  user: {
    id: string;
    email: string;
  };
  localIdentity: {
    subject: string;
    keyring: SubjectKeyring;
  };
};
```

### Auth Rules

```txt
cookie caller:
  Better Auth session cookie
  no explicit OAuth scope check
  trusted first-party session

bearer caller:
  Authorization: Bearer <access_token>
  issuer and audience verified
  access token signature verified through JWKS
  user exists in database
  scope includes workspaces:open
```

### Non-Goals

```txt
/api/session does not issue tokens.
/api/session does not refresh tokens.
/api/session is not OIDC userinfo.
/api/session is not an OAuth 2.1 metadata endpoint.
/api/session does not return arbitrary profile fields.
```

## Rename Map

### Routes And Tests

| Current | Target |
| --- | --- |
| `GET /api/me` | `GET /api/session` |
| `apps/api/src/api-me.test.ts` | `apps/api/src/api-session.test.ts` |
| route description `Return the authenticated user and their local workspace identity` | `Return the authenticated session projection` |

### Types

| Current | Target |
| --- | --- |
| `ApiMeResponse` | `ApiSessionResponse` |
| `callApiMe` | `callApiSession` |
| `fetchApiMe` | `fetchApiSession` |
| `apiMeBody` test helper | `apiSessionBody` |

### Comments And Specs

| Current Phrase | Target Phrase |
| --- | --- |
| `/api/me` | `/api/session` |
| `current-user endpoint` | `session projection endpoint` |
| `identity projection` | `session projection` where both `user` and `localIdentity` are returned |
| `me response` | `session response` |

Keep `localIdentity`, `subject`, `keyring`, and `accessTokenExpiresAt`.

## Implementation Plan

### Phase 1: Contract Rename

- [x] **1.1** Rename `ApiMeResponse` to `ApiSessionResponse` in `packages/auth/src/auth-types.ts`.
- [x] **1.2** Update exports from `packages/auth/src/index.ts` and `packages/auth-svelte/src/index.ts`.
- [x] **1.3** Add JSDoc to `accessTokenExpiresAt` documenting epoch milliseconds and transport-refresh-only semantics.
- [x] **1.4** Update all imports of `ApiMeResponse`.

### Phase 2: Server Route Rename

- [x] **2.1** Rename `GET /api/me` to `GET /api/session` in `apps/api/src/app.ts`.
- [x] **2.2** Update the route description to avoid OAuth/OIDC language.
- [x] **2.3** Rename `apps/api/src/api-me.test.ts` to `apps/api/src/api-session.test.ts`.
- [x] **2.4** Update test names and helpers from `apiMe` to `apiSession`.
- [x] **2.5** Keep bearer scope behavior unchanged: bearer callers require `workspaces:open`.
- [x] **2.6** Do not keep a `/api/me` alias.

### Phase 3: Client Call Sites

- [x] **3.1** Update `packages/auth/src/create-oauth-app-auth.ts` to call `/api/session`.
- [x] **3.2** Rename `callApiMe` to `callApiSession`.
- [x] **3.3** Update `packages/auth/src/node/machine-auth.ts` to call `/api/session`.
- [x] **3.4** Rename `fetchApiMe` to `fetchApiSession`.
- [x] **3.5** Update account/profile query call sites that use `auth.fetch('/api/me')`.
- [x] **3.6** Update tests in `packages/auth/src/contract.test.ts` and `packages/auth/src/node/machine-auth.test.ts`.

### Phase 4: Docs And Specs

- [x] **4.1** Update `docs/encryption.md`.
- [x] **4.2** Update `docs/guides/consuming-epicenter-api.md`.
- [x] **4.3** Update auth and workspace README references.
- [x] **4.4** Update previous accepted specs only where they are used as current references. Preserve historical specs where changing them would obscure the decision trail.
- [x] **4.5** Update `.agents/skills/auth/SKILL.md` so future agents use `/api/session`.

### Phase 5: Verification

- [x] **5.1** Run targeted auth tests.

```bash
bun test packages/auth/src/contract.test.ts
bun test packages/auth/src/node/machine-auth.test.ts
bun test apps/api/src/api-session.test.ts
```

- [x] **5.2** Run API auth/resource tests.

```bash
bun test apps/api/src/auth/resource-boundary.test.ts
bun test apps/api/src/auth/oauth-metadata.test.ts
```

- [x] **5.3** Run static search.

```bash
rg -n "/api/me|ApiMeResponse|callApiMe|fetchApiMe|api-me|apiMe" apps packages docs specs .agents
```

- [x] **5.4** Run package typecheck or the nearest repo-standard check.

```bash
bun run check
```

If `bun run check` is too broad or unavailable, use the smallest existing package checks that cover `apps/api`, `packages/auth`, and `packages/auth-svelte`.

## Edge Cases

### Existing Stored Auth Cells

The persisted cell does not store the route name. It stores:

```txt
grant
localIdentity
```

No migration is needed. Existing cells will use the new route on next network verification.

### Offline Cold Boot

Offline cold boot is unchanged. The app can read cached `localIdentity` and open local data. The first bearer-bearing network call fails closed until `/api/session` verifies the cell.

### Stale Access Token

The refresh path remains unchanged:

```txt
access token stale
  -> POST /auth/oauth2/token grant_type=refresh_token
  -> update grant
  -> GET /api/session
  -> attach bearer only if verified
```

### Same-Subject Guard Mismatch

The guard remains unchanged:

```txt
persisted localIdentity.subject = alice
/api/session localIdentity.subject = bob
  -> clear persisted cell
  -> publish signed-out
  -> do not attach bearer
```

### Cookie Caller

Cookie callers can call `/api/session` just like `/api/me` today. The endpoint remains under `/api/*`, so `requireOriginForCookieMutations` behavior is unchanged for mutating routes and irrelevant for this GET.

### Account Popover

The account popover can continue to query the combined endpoint for `user.email`. This is acceptable because the route is now named `session`, not `workspace-identity`.

## Open Questions

### Should The Route Be `/api/session` Or `/api/workspace-session`?

Recommendation: `/api/session`.

`workspace-session` is more explicit, but it risks implying this route is only for workspace surfaces. The endpoint also serves account/profile display and general auth verification. `session` names the combined concept better.

### Should `resolveBearerIdentity` Be Renamed?

Recommendation: defer to implementation.

This helper returns an `ApiSessionResponse`-compatible identity projection for bearer callers. It may still earn `resolveBearerIdentity` because the resolver is not the route. If the implementation reads awkwardly after `ApiSessionResponse`, rename to `resolveBearerSession`.

### Should Historical Specs Be Edited?

Recommendation: update current reference docs and skills, but do not rewrite old historical specs wholesale.

Old specs should remain useful as a decision trail. Add a short supersession note where needed instead of mass-editing every old mention.

## Acceptance Criteria

The clean break is complete when:

```txt
1. /api/session is the only session projection route.
2. /api/me has no route, no alias, and no live code callers.
3. ApiSessionResponse is the canonical response type.
4. Bearer callers still require workspaces:open.
5. Auth still makes one call for session projection, not two.
6. accessTokenExpiresAt is documented as epoch milliseconds.
7. Targeted auth and API tests pass.
8. Static search shows no live /api/me names outside historical specs.
```

## Final Position

Do the clean break as one route rename, not a split.

```txt
Best final API:
  GET /api/session

Best final shape:
  { user, localIdentity }

Best final invariant:
  one session projection call proves the auth cell and returns the local identity needed to open the workspace.
```

