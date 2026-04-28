# Workspace sync: add `failed` phase, reject `whenConnected` on permanent failure

**Status**: ready to implement
**Tracking**: replaces the CLI-side `--connect-timeout` stopgap

## One-line goal

Make `whenConnected` reject promptly when a workspace's connection fails for reasons that won't fix themselves on retry (auth rejected by server), so callers can give up cleanly without bolting wallclock timers on top.

---

## The problem

Today, `attachSync` has two terminal states:

```
                    ┌──────────────────┐
                    │ retries forever  │
   offline ──→ connecting ──┐
                    └──→ connected
                                  ↑
                     (whenConnected resolves here)
```

A doc destroy is the only thing that rejects `whenConnected`. Auth failures fall into the unbounded retry loop at `attach-sync.ts:587`. The supervisor backs off forever. There is **no concept of "give up."**

This forces every caller that wants bounded startup to invent its own clock. The CLI does it via `--connect-timeout` (now a hardcoded 10 s ceiling). A future Tauri app would have to do the same.

### Why the client can't already tell

Today, auth fails at the HTTP layer. `apps/api/src/app.ts:296` runs `authGuard` on `/workspaces/*`, which returns HTTP 401 if `getSession()` is null. The browser's `WebSocket` API does **not** expose the upgrade response code to JavaScript. The client sees `onerror` then `onclose(1006)`, indistinguishable from network failure:

```
   client                     relay
     │                          │
     │── upgrade w/ token ─────→│
     │                          │ (token invalid)
     │←──── HTTP 401 ───────────│
     │                          │
     │  browser:                │
     │   onerror, onclose(1006) │
     │   "must be a network     │
     │    blip, retry…"         │
```

Two distinct failure modes (bad credentials vs. flaky wifi) surface as the same close event. Until the server tells us in a way the browser actually exposes, the client can't act on it.

---

## The design

Three coordinated changes. Wire format adds **zero protocol surface**.

### 1. Server signals "give up" via WebSocket close code 4401

Standard WebSocket close frame. Browser exposes `event.code: number` and `event.reason: string` on `CloseEvent`. App-defined codes live in `4000–4999`.

```
close frame body:
  ┌──────────────────┬──────────────────────────────────┐
  │ 2 bytes: 4401    │ ≤ 123 bytes UTF-8: reason        │
  └──────────────────┴──────────────────────────────────┘
```

Reason carries `JSON.stringify({ code })` where `code` is a short canonical string:

```ts
// Documented codes (server vocabulary; client treats as forward-compatible)
'invalid_token'    // bearer token didn't validate
'token_expired'    // token validated but is past expiry
'deauthorized'     // server revoked access for this user
```

Reason format example: `{"code":"invalid_token"}` (24 bytes; comfortable headroom under the 123-byte ceiling for future fields).

#### Why close code, not a protocol frame

`packages/sync/src/protocol.ts:35` already reserves `MESSAGE_TYPE.AUTH = 2` (the y-protocols slot). y-protocols' `messagePermissionDenied` defines the same content shape: a single `varString` reason. **Same content, two delivery channels.** The close-code path adds zero protocol surface; the frame path adds an encoder, decoder, and message-type dispatch case for content we already fit in 123 bytes.

If a future feature needs an in-band auth channel (challenge/response, soft refresh), the y-protocols slot is still there to grow into. We just don't claim it for this.

### 2. Server change: in-band reject on WS upgrade

Today `apps/api/src/app.ts:282` returns HTTP 401 for any failed-auth request, including WebSocket upgrades. We add one branch: for WS upgrades, accept the socket and immediately close it with code 4401 instead.

```ts
// apps/api/src/app.ts (authGuard)
const result = await c.var.auth.api.getSession({ headers });

if (!result) {
  if (c.req.header('upgrade') === 'websocket') {
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    server.accept();
    server.close(4401, JSON.stringify({ code: 'invalid_token' }));
    return new Response(null, { status: 101, webSocket: client });
  }
  return c.json(AiChatError.Unauthorized(), 401);
}
```

Hibernation API not needed: the connection closes immediately, so we don't need the DO to persist it across eviction (confirmed against Cloudflare docs). The DO at `apps/api/src/base-sync-room.ts` is **untouched** — auth stays a single concern owned by `authGuard`.

#### Why authGuard, not the DO

| Concern | Move into DO | Modify authGuard |
|---|---|---|
| Single source of truth for "is user logged in" | split (HTTP path vs WS path) | one place |
| DO knows about auth | yes (new responsibility) | no (unchanged) |
| Risk of HTTP-401 / WS-reject drift | high | low (same `getSession` call) |
| Code change scope | DO edit + authGuard edit | authGuard edit |

### 3. Client: new `phase: 'failed'`

```ts
// packages/workspace/src/document/attach-sync.ts:89
type AuthRejectCode = string;  // canonical strings; trust unknown values

type SyncFailedReason = { type: 'auth'; code: AuthRejectCode };

export type SyncStatus =
  | { phase: 'offline' }
  | { phase: 'connecting'; retries: number; lastError?: SyncError }
  | { phase: 'connected'; hasLocalChanges: boolean }
  | { phase: 'failed'; reason: SyncFailedReason };  // NEW
```

Semantics:
- `failed` means *"stop retrying. The cause is not transient."*
- Entering `failed` halts the supervisor loop.
- `reconnect()` resets `failed` → `connecting` (e.g. after `epicenter auth login`).

`code` is typed as `string`, not a closed enum: the server is the source of truth for the vocabulary, and adding a new code (e.g. `rate_limited`) shouldn't require a client release. Callers that want to render specific UX for known codes can switch on the string literal.

#### What plumbs the close code into `failed`

A closure-scoped flag, written by `ws.onclose`, read by the supervisor loop:

```ts
// runLoop scope
let permanentFailure: SyncFailedReason | null = null;

ws.onclose = (event: CloseEvent) => {
  // ... existing cleanup at attach-sync.ts:694
  if (event.code === 4401) {
    permanentFailure = parsePermanentFailure(event.reason);
  }
  resolveOpen(false);
  resolveClose();
};
```

`parsePermanentFailure` is failsafe: invalid JSON or missing `code` → `{ type: 'auth', code: 'unknown' }`. A buggy server can't strand the client in a half-state.

The supervisor loop checks the flag at its top:

```ts
async function runLoop() {
  while (desired === 'online' && !permanentFailure) {
    // ... existing iteration body (attach-sync.ts:587)
  }
  if (permanentFailure) {
    status.set({ phase: 'failed', reason: permanentFailure });
  } else {
    status.set({ phase: 'offline' });
  }
}
```

### 4. `whenConnected` rejects on `failed`

Today `whenConnected` resolves only via the inline call inside the message handler at `attach-sync.ts:745`. We replace that with a single status subscriber set up at construction:

```ts
const unsub = status.subscribe((s) => {
  if (s.phase === 'connected') {
    settleConnected(resolveConnected);
    unsub();
  } else if (s.phase === 'failed') {
    settleConnected(rejectConnected, new SyncFailedError(s.reason));
    unsub();
  }
});
```

`whenConnected` now follows three paths:

| Outcome | Means |
|---|---|
| Resolves | First handshake completed |
| Rejects with `SyncFailedError` | Server sent close 4401 |
| Rejects with destroy error | Doc destroyed before handshake |

The CLI's `runUp` deletes its `raceTimeout` / `CONNECT_TIMEOUT_MS` and just `await`s.

### 5. `reconnect()` un-sticks `failed`

Existing `reconnect()` at `attach-sync.ts:915` bumps `runId` and triggers a new iteration. One added line:

```ts
reconnect() {
  permanentFailure = null;  // un-stick from 'failed'
  runId++;
  // ... existing kick logic
}
```

Use case: user runs `epicenter auth login` after a workspace has given up. A future `epicenter reconnect --workspace <name>` IPC verb (or restart of `up`) calls `sync.reconnect()` to retry with the freshly-stored token.

---

## How retries change

| Cause | Effect |
|---|---|
| Server closes with code 4401 | `phase: 'failed'`; supervisor exits; `whenConnected` rejects |
| Server closes with any other code (1006, 1011, etc.) | `phase: 'connecting'`; retry with backoff (existing) |
| `getToken()` throws or returns null | `phase: 'connecting'` with `lastError: auth`; retry (existing) |
| Doc destroyed | `whenConnected` rejects with destroy error (existing) |

`getToken()` failures stay transient: the user might call `epicenter auth login` and recover. Permanent auth failure is *only* when the server explicitly says "no" via close 4401.

---

## Free benefit: mid-session rejection

The same mechanism handles auth revoked during a live connection. If the server decides at any time that a session is no longer valid, it can call `ws.close(4401, ...)` and the client's existing `ws.onclose` handler routes it to `phase: 'failed'`. No additional design.

This is not the goal of the spec, but it falls out of the close-code approach for free.

---

## Phased plan

The server change is the only piece that crosses repos. Plan around that.

### Phase 1 — client only (no server dependency)

Client states exist but nothing produces `failed` yet. Behavior change is invisible to users.

- [x] Add `phase: 'failed'` to `SyncStatus`. Add `SyncFailedReason` type.
- [x] Add `SyncFailedError` typed error class.
- [x] Add `permanentFailure` flag, written by `ws.onclose` on code 4401, read by `runLoop`.
- [x] Add `parsePermanentFailure` (failsafe JSON.parse with fallback to `{ code: 'unknown' }`).
- [x] Replace inline `settleConnected(resolveConnected)` with a status subscriber that settles on `connected` or `failed`.
- [x] `reconnect()` clears `permanentFailure`.
- [x] Tests: status transitions, `whenConnected` rejection on simulated `failed`, `reconnect()` resets cleanly, malformed reason falls back to `code: 'unknown'`.

> **Discovered during implementation**: `ensureSupervisor`'s `.finally` self-restart hook (currently line 914) restarts the loop whenever `desired === 'online'`. Entering `failed` doesn't flip `desired`, so without an extra guard the supervisor relaunched indefinitely (tight infinite loop, runLoop exiting and re-emitting `phase: 'failed'`). Fix: the guard now reads `if (!torn && desired === 'online' && !permanentFailure) ensureSupervisor()`. One added clause.

### Phase 2 — server in-band reject

- [ ] `apps/api/src/app.ts` authGuard: branch on `upgrade: websocket` header when `getSession` returns null. Accept WS, send `close(4401, JSON.stringify({ code: 'invalid_token' }))`, return 101.
- [ ] Tests: bad token over WS upgrade closes with 4401; HTTP 401 still returned for non-upgrade requests; valid token still proceeds to DO.

### Phase 3 — CLI cleanup

- [ ] Delete `CONNECT_TIMEOUT_MS` constant from `packages/cli/src/commands/up.ts`.
- [ ] Delete `RunUpDeps.connectTimeoutMs`.
- [ ] Delete `raceTimeout` and `connectFailedMessage` helpers.
- [ ] Replace `await raceTimeout(...)` with `await entry.workspace.sync?.whenConnected`.
- [ ] When `whenConnected` rejects with `SyncFailedError`, render `reason.code`.
- [ ] Update `cli-up-long-lived-peer.md` spec: drop the "10 s ceiling" qualifier.

---

## Acceptance criteria

- [ ] **Auth rejection is fast.** With a deliberately invalid token, `epicenter up` exits within the round-trip time of one handshake (<500 ms typical, no 10-second wait).
- [ ] **Network blips still retry.** Bringing the relay down briefly with a valid token does not transition the workspace to `failed`. The supervisor retries; banner shows `connecting (retry N)`.
- [ ] **Reconnect after auth fix works.** With a permanently-failed workspace, calling `sync.reconnect()` after `epicenter auth login` reaches `connected`.
- [ ] **`whenConnected` typed rejection.** Catching it surfaces `SyncFailedError` with `reason.type === 'auth'` and a populated `code` string. No magic strings in callers (they switch on `code`).
- [ ] **Multiple workspaces independent.** One workspace's `failed` doesn't taint another's `connecting`/`connected`.
- [ ] **Malformed reason is safe.** Server sending `close(4401, "")` or `close(4401, "{not json}")` results in `phase: 'failed'` with `code: 'unknown'`, not a thrown error or stuck state.

---

## Things we're not doing

- **`SyncError` variants for `connection` / `protocol` failures.** Only `auth` produces `failed` today. Add variants when something actually emits them.
- **Bounded retries on transient errors.** Daemons should keep trying when the network returns. The whole point of `failed` is to distinguish "give up" (auth) from "keep trying" (network).
- **`epicenter reconnect` CLI verb.** Implied by `reconnect()` becoming meaningful, but the CLI surface is a separate spec.
- **Backwards compatibility shims.** Phase-1 clients on a phase-2 relay: get close 4401, ignore it (existing behavior treats non-1000 codes as transient), retry forever. Phase-2 clients on an old relay: never see the 4401, retry forever (same as today). No flag day; both ends degrade to "today's behavior."
- **Adopting the `MESSAGE_TYPE.AUTH = 2` slot.** Reserved, deliberately unused. When an in-band auth channel earns its keep, claim it then.

---

## File map

```
apps/api/src/app.ts                              # phase 2: authGuard WS-reject branch
packages/workspace/src/document/
  attach-sync.ts                                 # phase 1: SyncStatus, runLoop, ws.onclose, whenConnected
  errors.ts (or wherever SyncError lives)        # phase 1: SyncFailedError, SyncFailedReason
packages/cli/src/commands/up.ts                  # phase 3: delete CONNECT_TIMEOUT_MS + raceTimeout
specs/20260426T235000-cli-up-long-lived-peer.md  # phase 3: drop 10s ceiling note
```

Estimated total: ~150 LOC across 4 files.
