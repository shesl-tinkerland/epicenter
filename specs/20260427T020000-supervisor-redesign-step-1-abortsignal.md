# Step 1: AbortSignal-ify cancellation

**Date:** 2026-04-27
**Status:** Draft
**Author:** AI-assisted (Braden + Claude)
**Branch:** `post-pr-1705-cleanup`
**Umbrella:** [`20260427T010000-supervisor-redesign.md`](./20260427T010000-supervisor-redesign.md)

## One-sentence thesis

Replace the four hand-rolled cancellation flags (`runId`, `desired`, `torn`, `currentSupervisorPromise`) with one `AbortController` per `attachSync` call so cancellation becomes structural rather than convention-enforced.

## Overview

This step is pure internal refactor. No public API changes. No behavior changes that callers can observe. The supervisor loop, `goOffline()`, `reconnect()`, `rpc()`, and the dispose handler all migrate from manual `runId` checks to `AbortSignal`-based cancellation.

The win: every bug class found in the audit (silent reconnect death, missed runId checks after awaits, post-dispose timer leaks) becomes structurally impossible. Cancellation is one signal that propagates through every primitive that supports `{ signal }`, which today is every modern Web API plus the helpers we own.

## Motivation

### Current state

`attach-sync.ts` uses four orthogonal mechanisms to manage "should this work continue?":

```ts
let desired: 'online' | 'offline' = 'offline';   // user intent
let runId = 0;                                    // monotonic iteration counter
let torn = false;                                 // post-dispose latch
let currentSupervisorPromise: Promise<void> | null = null;  // running loop handle
```

Inside `runLoop`, every `await` is followed by:

```ts
if (cancelled(myRunId)) continue;
```

Where `cancelled` is:

```ts
const cancelled = (myRunId: number): boolean => {
  if (runId === myRunId) return false;
  lastError = undefined;
  return true;
};
```

This pattern repeats four times in `runLoop` plus implicitly throughout the message handlers, the dispose handler, and the public methods. There is no compiler enforcement that an `await` is followed by a `cancelled` check; missing one is a race.

### The bugs this produced

The audit conversation produced four P0 bugs in this exact area:

1. **`reconnect()` race** (commit `f58209c02`): `reconnect()` did not flip `desired = 'online'` before calling `ensureSupervisor()`, so the early-return on `currentSupervisorPromise` left the loop with `desired = 'offline'` and nothing restarted it.

2. **`whenConnected` hang** (commit `f58209c02`): if the first handshake never landed, `whenConnected` stayed pending forever. No mechanism propagated "this work is done" to the promise.

3. **`rpc()` post-dispose leak** (commit `f58209c02`): post-dispose `rpc()` calls registered `setTimeout` entries that nothing cleared, leaking until the 5s timeout fired.

4. **Reconnect race fix was incomplete** (commit `f58209c02`): the same race was reachable through a status subscriber calling `reconnect()` from inside `runLoop`'s synchronous offline tail. Required a second fix to chain a restart in the `.finally`.

Each bug was a real defect. The pattern is what matters: hand-rolled cancellation requires perfect human discipline at every `await` boundary, and the bugs we found are the ones we noticed. The ones we did not notice are still there.

### Desired state

One `AbortController` per `attachSync` call. Every internal `await` uses `{ signal }`. `goOffline()` aborts a child controller; `reconnect()` recreates it. Dispose aborts the master controller. The `desired`, `runId`, `torn`, and `currentSupervisorPromise` flags disappear; their information is encoded in the signal's `aborted` state and the controller hierarchy.

```ts
async function runLoop(signal: AbortSignal) {
  while (!signal.aborted) {
    try {
      const token = await getToken({ signal });   // throws on abort
      const ws = await connect(url, { signal });  // throws on abort
      await runSession(ws, signal);                // throws on abort
    } catch (err) {
      if (signal.aborted) return;                  // clean exit
      // Real error: log, sleep with backoff, retry
      await sleep(backoff.next(), { signal });
    }
  }
}
```

No manual cancellation checks. The signal IS the check.

## Research findings

### What `AbortSignal` actually does for us

| Capability | Manual `runId` today | `AbortSignal` |
|---|---|---|
| Propagate "stop" to deeply-nested awaits | Manual checks at every level | Automatic via `{ signal }` parameter |
| Compose multiple sources of cancellation | Custom logic per pair | `AbortSignal.any([s1, s2])` |
| Throw on already-cancelled work | Manual `if (cancelled) return` | `signal.throwIfAborted()` |
| Cancel an in-flight `fetch` or `WebSocket` | Not possible | Native support |
| Cancel a timer | Custom `clearTimeout` tracking | `setTimeout(fn, ms, { signal })` (Node 18.7+) |
| Race against an event source | Manual handler tracking | `addEventListener('event', cb, { signal })` removes on abort |

The killer feature is the last row: `addEventListener('change', handler, { signal })` automatically detaches the handler when the signal aborts. This eliminates the manual `unsubscribe` tracking that runs through `peer.ts` and `peer-system.ts`.

### Runtime support

- `AbortController` / `AbortSignal`: universally supported (Node 15+, all browsers since 2022)
- `AbortSignal.any([...])`: Node 20.3+, all major browsers as of 2024. Polyfill is trivial (15 lines) if older runtimes matter.
- `AbortSignal.timeout(ms)`: same support as `.any`. Polyfill is one line: `(ms) => { const c = new AbortController(); setTimeout(() => c.abort(), ms); return c.signal; }`.

We target modern runtimes (Bun, modern browsers, Node 20+). All required APIs are available natively.

### Patterns from adjacent ecosystems

| Project | Cancellation primitive | Notes |
|---|---|---|
| `fetch` / `WebSocket` (browser) | `AbortSignal` | Standard. Every Web API supports it. |
| Node `child_process`, `fs`, `streams` | `AbortSignal` | Added in Node 15+. Now ubiquitous. |
| TanStack Query | `AbortSignal` per query | Composable, automatic on stale queries. |
| `@grpc/grpc-js` | `AbortSignal` (and deadline) | Modern; older was `Metadata.deadline`. |
| `gRPC-Web` | `AbortController.signal` | Same as fetch. |
| `tRPC` | `AbortSignal` per call | Standard since v10. |

Every modern TS/JS RPC system uses `AbortSignal`. The current `runId` pattern in `attach-sync.ts` predates `AbortSignal` becoming the de facto standard.

## Design decisions

| Decision | Choice | Rationale |
|---|---|---|
| Cancellation primitive | `AbortSignal` | Standard, composable, eliminates manual checks |
| Number of controllers per `attachSync` | One master + one per "connection cycle" | Master aborts on dispose; per-cycle aborts on `goOffline()`/`reconnect()` |
| Public API change | None in this step | Step 3 will restructure the public API; this step is pure internal |
| `goOffline()` / `reconnect()` semantics | Preserved | Both abort the per-cycle controller; `reconnect()` then creates a fresh one |
| `whenConnected` hang fix | Already shipped (commit `f58209c02`) | Step 1 preserves the dispose-rejection behavior; the controller's abort triggers it |
| Backwards compat for `getToken` | `getToken` now optionally receives `signal` | Existing implementations ignore the new param; new ones can honor it |
| `setTimeout` cancellation | Use `AbortSignal` directly via Node 18.7+ option | Falls back to manual `clearTimeout` if signal API unavailable |
| Test surface | Same observable behavior; tests should not need rewrite | If tests need rewrite, that signals a behavior change we did not intend |

## Architecture

### Before: four orthogonal flags

```
┌─────────────────────────────────────────────────────────────┐
│  attachSync()                                               │
│                                                             │
│  let desired:  'online' | 'offline' = 'offline'             │
│  let runId:    number = 0                                   │
│  let torn:     boolean = false                              │
│  let currentSupervisorPromise: Promise<void> | null = null  │
│                                                             │
│  goOffline() {                                              │
│    desired = 'offline'; runId++; ws.close(); status.set()   │
│  }                                                          │
│  reconnect() {                                              │
│    if (torn) return                                         │
│    runId++; backoff.reset(); ws.close()                     │
│    desired = 'online'                                       │
│    ensureSupervisor()                                       │
│  }                                                          │
│  ydoc.once('destroy', () => {                               │
│    torn = true                                              │
│    clearPendingRequests(); goOffline(); ...                 │
│  })                                                         │
│                                                             │
│  runLoop:                                                   │
│    while (desired === 'online') {                           │
│      const myRunId = runId                                  │
│      const token = await getToken()                         │
│      if (cancelled(myRunId)) continue   ← manual check      │
│      await attemptConnection()                              │
│      if (cancelled(myRunId)) continue   ← manual check      │
│      ...                                                    │
│    }                                                        │
└─────────────────────────────────────────────────────────────┘
```

Every state transition involves multiple flags. Every await needs a manual check. The relationship between `desired`, `runId`, and `currentSupervisorPromise` is enforced by convention.

### After: one signal hierarchy

```
┌─────────────────────────────────────────────────────────────┐
│  attachSync()                                               │
│                                                             │
│  const masterController = new AbortController()             │
│  const masterSignal = masterController.signal               │
│                                                             │
│  let cycleController: AbortController = ...                 │
│  // child of master, aborts on goOffline/reconnect          │
│                                                             │
│  goOffline() {                                              │
│    cycleController.abort()                                  │
│    status.set({ phase: 'offline' })                         │
│  }                                                          │
│  reconnect() {                                              │
│    if (masterSignal.aborted) return                         │
│    cycleController.abort()                                  │
│    cycleController = childOf(masterSignal)                  │
│    ensureSupervisor()                                       │
│  }                                                          │
│  ydoc.once('destroy', () => {                               │
│    masterController.abort()                                 │
│    // pending RPCs, supervisor loop, timers all abort       │
│  })                                                         │
│                                                             │
│  runLoop(cycleSignal):                                      │
│    while (!cycleSignal.aborted) {                           │
│      try {                                                  │
│        const token = await getToken({ signal: cycleSignal })│
│        await attemptConnection({ signal: cycleSignal })     │
│      } catch (err) {                                        │
│        if (cycleSignal.aborted) return                      │
│        await sleep(backoff.next(), { signal: cycleSignal }) │
│      }                                                      │
│    }                                                        │
└─────────────────────────────────────────────────────────────┘
```

One signal per logical scope. Aborting a child does not abort the master. Aborting the master cascades to all children.

### State machine equivalence

The four flags map to signal states as follows:

| Old flag | Old value | New equivalent |
|---|---|---|
| `desired === 'online'` | `true` | `cycleSignal.aborted === false` |
| `desired === 'offline'` | `true` | `cycleSignal.aborted === true` |
| `runId++` | (effect: cancels iteration) | `cycleController.abort()` |
| `torn === true` | `true` | `masterSignal.aborted === true` |
| `currentSupervisorPromise !== null` | `true` | (implicit: tracked by Promise the loop returns) |

The `currentSupervisorPromise` handle survives in a much smaller form: a single `loopPromise` ref that the dispose handler awaits. The `.finally` chain restart logic disappears entirely because the loop, when it exits naturally on `cycleSignal.aborted`, has nothing to restart against.

### Helper: `childSignal(parent)`

A small helper centralizes the parent-child controller pattern:

```ts
function childSignal(parent: AbortSignal): AbortController {
  const child = new AbortController();
  if (parent.aborted) {
    child.abort(parent.reason);
  } else {
    parent.addEventListener('abort', () => child.abort(parent.reason), {
      once: true,
      signal: child.signal,  // self-cleanup if child aborts first
    });
  }
  return child;
}
```

15 lines of helper that replaces the entire flag-coordination apparatus.

## Implementation plan

### Phase 1: Foundation

- [ ] **1.1** Add `signal?: AbortSignal` to `SyncAttachmentConfig` (optional user-supplied parent).
- [ ] **1.2** Construct master controller in `attachSync`: `const masterController = new AbortController()`. Compose with user signal if provided: `const masterSignal = AbortSignal.any([masterController.signal, ...maybeUserSignal])`.
- [ ] **1.3** Add the `childSignal(parent)` helper at the top of the file (or in a sibling util).
- [ ] **1.4** Construct the initial `cycleController = childSignal(masterSignal)` (to be replaced on `reconnect()`).

### Phase 2: Supervisor loop

- [ ] **2.1** Rewrite `runLoop` to take `cycleSignal: AbortSignal` and exit on `cycleSignal.aborted`.
- [ ] **2.2** Replace every `if (cancelled(myRunId)) continue` with `try`/`catch (err) { if (cycleSignal.aborted) return; ... }`.
- [ ] **2.3** Pass `{ signal: cycleSignal }` to `getToken` (when present) and `attemptConnection`.
- [ ] **2.4** Rewrite `attemptConnection` to honor the signal: WebSocket open should abort if the signal fires; pending close should abort if the signal fires.
- [ ] **2.5** Delete the `cancelled` helper, `runId`, `desired`, `currentSupervisorPromise`, and `torn` declarations.
- [ ] **2.6** Replace `desired === 'online'` checks with `!cycleSignal.aborted`.

### Phase 3: Public methods

- [ ] **3.1** `goOffline()`: `cycleController.abort()`. Status flip stays.
- [ ] **3.2** `reconnect()`: `if (masterSignal.aborted) return; cycleController.abort(); cycleController = childSignal(masterSignal); ensureSupervisor();`. The early-return-on-`torn` becomes early-return-on-`masterSignal.aborted`.
- [ ] **3.3** `ensureSupervisor()`: starts a fresh `runLoop(cycleController.signal)` if one is not already running. Uses a single `loopPromise` ref that resolves when the loop exits.
- [ ] **3.4** Dispose handler: `masterController.abort()` first thing; then `await loopPromise`; then `waitForWsClose`.
- [ ] **3.5** Replace the `if (torn) return Disconnected()` guard in `rpc()` with `if (masterSignal.aborted) return Disconnected()`. (Behavior identical; just uses the signal as the source of truth.)

### Phase 4: RPC + presence integration

- [ ] **4.1** `rpc()` accepts an optional `signal` in its options object. Compose with master: per-call signal = `AbortSignal.any([options.signal, masterSignal, AbortSignal.timeout(timeoutMs)])`.
- [ ] **4.2** Replace the manual `setTimeout`/`clearTimeout` in `rpc()` with `AbortSignal.timeout(timeoutMs)` composed into the per-call signal. Pending entry resolves when the composed signal aborts.
- [ ] **4.3** `clearPendingRequests()` becomes simpler: it just iterates and resolves with `Disconnected`, since timer tracking now lives in signal disposal. Can probably stay as-is; verify after the rewrite.

### Phase 5: Verification

- [ ] **5.1** Run the existing 700-test suite. Should pass without modification.
- [ ] **5.2** Reproduce all four P0 scenarios from the audit. Each should now be structurally impossible (TypeScript or runtime errors should not be reachable).
- [ ] **5.3** Manual smoke test: `bun run dev` in tab-manager, `epicenter list --peer macbook-pro` in CLI. Reconnect, dispose, retry — observe no hangs, no leaked timers (use `process._getActiveHandles()` if needed).
- [ ] **5.4** Spawn a fresh bug-hunt subagent against post-Step-1 `attach-sync.ts` using the same prompt template from the audit conversation. Find what we missed.

### Phase 6: Documentation

- [ ] **6.1** Update `SYNC_ARCHITECTURE.md`'s "supervisor loop" section to reference signals instead of `runId`.
- [ ] **6.2** Update the umbrella spec's "After Step 1" entry from "Draft" to a brief retrospective: what we learned, what's different in Step 2's spec as a result.
- [ ] **6.3** Mark this spec as "Implemented" in the header.

## Edge cases

### `reconnect()` called when `goOffline()` is mid-iteration

1. `goOffline()` calls `cycleController.abort()`. The signal fires synchronously on subscribers.
2. `runLoop`'s in-flight `await` throws an `AbortError`.
3. `runLoop`'s catch sees `cycleSignal.aborted === true`, returns cleanly.
4. `reconnect()` is called: `cycleController.abort()` is a no-op (already aborted); `cycleController = childSignal(masterSignal)` creates a fresh one; `ensureSupervisor()` starts a new loop on the new signal.
5. Old loop's `loopPromise` has resolved; new loop's `loopPromise` takes its place.

The race that the original `runId` pattern struggled with is gone: there is no shared mutable counter to coordinate. Each loop iteration owns its signal; aborting one cycle does not affect another.

### `reconnect()` called from inside a status subscriber during `goOffline()`'s synchronous tail

This was the bug that defeated the first attempted fix. Walk through it now:

1. `goOffline()` aborts `cycleController`. `runLoop` exits its current await with an `AbortError`. Its catch sees `aborted`, returns.
2. `goOffline()` synchronously calls `status.set({ phase: 'offline' })`.
3. A subscriber calls `reconnect()` from inside `status.set`.
4. `reconnect()`: master not aborted, current cycle already aborted (no-op), create fresh cycle, `ensureSupervisor()`.
5. `ensureSupervisor()`: previous `loopPromise` may still be in its synchronous tail or microtask queue, but we don't care — the new cycle has a different signal. Start a new loop.

There is no race because the new loop's signal is unrelated to the old loop's signal. Aborting an already-aborted controller is a no-op. The only invariant: `ensureSupervisor` should not start TWO loops simultaneously. We track this with a single `loopPromise` ref that's nulled when the loop exits.

Compared to the old `currentSupervisorPromise` early-return pattern, the new pattern is simpler: if a loop is running, leave it alone (it's running on the current cycle signal); if not, start one.

### Master signal aborted mid-RPC

1. User disposes the doc.
2. `masterController.abort()` fires.
3. Per-call composed signals (`AbortSignal.any([..., masterSignal, ...])`) all fire.
4. Each pending `rpc()` Promise resolves with `Disconnected` (matching today's behavior).
5. `clearPendingRequests()` may be redundant after this, since each pending entry self-resolves on its signal. Keep it for now as a belt-and-suspenders; remove in Phase 5.3 verification if confirmed unnecessary.

### `getToken` throws

1. `runLoop`'s `await getToken({ signal })` rejects with the user error (not `AbortError`).
2. Catch block: `if (cycleSignal.aborted) return;` is false (we aborted because of an error, not cancellation).
3. Log the error (or surface as `lastError`), `await sleep(backoff.next(), { signal })`, continue.

If `getToken` throws because the signal aborted (the user honored the signal correctly), the catch sees `cycleSignal.aborted === true` and returns cleanly. This is the same behavior as today, just simpler.

### `getToken` returns null

Same as today: requires-token path sleeps with backoff and retries on the next iteration. The signal handling is orthogonal to the null-token logic.

## Open questions

1. **Should the public `signal` option in `SyncAttachmentConfig` be `signal?: AbortSignal` or `parentSignal?: AbortSignal`?**
   - Options: (a) `signal` (matches Web API convention), (b) `parentSignal` (clarifies it's the parent of the master, not the master itself)
   - **Recommendation:** `signal`. Matches `fetch`/`WebSocket`/`setTimeout` convention; users will expect this name. Document in JSDoc that aborting it disposes the attachment.

2. **Should `goOffline()` and `reconnect()` survive at all, or should they be replaced by aborting/re-creating the user's signal?**
   - Options: (a) Keep both as-is (preserves API), (b) Drop both; user controls lifecycle via their own controller
   - **Recommendation:** Keep both. They're imperative methods that map cleanly onto the new mechanism. Removing them would force every caller to create their own controllers, which is more boilerplate for the same effect.

3. **Should `attemptConnection` be inlined into `runLoop` post-refactor?**
   - Today it's a separate function because it needed to coordinate `runId` checks across awaits. Post-refactor, much of that ceremony disappears.
   - **Recommendation:** Defer to the implementation. If `attemptConnection` becomes < 50 lines, inline it. If still complex, keep separate.

4. **Should `whenConnected` rejection on dispose stay, or should it move to the signal-based pattern?**
   - The current implementation (commit `f58209c02`) uses a `connectedSettled` latch and `rejectConnected` from `Promise.withResolvers`. After Step 1, the master signal aborting could trigger the rejection more directly.
   - **Recommendation:** Keep the latch pattern but rewire it: subscribe to `masterSignal.addEventListener('abort', () => rejectIfPending(), { once: true })`. The latch becomes a signal-driven side-effect rather than something the dispose handler must remember to call.

## Success criteria

- [ ] All four flags (`runId`, `desired`, `torn`, `currentSupervisorPromise`) are removed from `attach-sync.ts`.
- [ ] The `cancelled(myRunId)` helper is removed.
- [ ] Every `await` in the supervisor loop relies on the signal for cancellation, not a manual check.
- [ ] `goOffline()` and `reconnect()` preserve their public behavior (callers see no difference).
- [ ] `rpc()` accepts an optional `signal` in its options object.
- [ ] All 700 existing tests pass without modification.
- [ ] Manual reproduction of all four audit-found P0 scenarios shows them structurally impossible.
- [ ] A fresh bug-hunt subagent against the post-refactor file finds nothing in the cancellation primitive.
- [ ] `SYNC_ARCHITECTURE.md`'s supervisor section is updated.
- [ ] The umbrella spec is revised with retrospective notes on what Step 1 taught us.

## References

- `packages/workspace/src/document/attach-sync.ts` — primary file under refactor
- `packages/workspace/src/document/attach-sync.test.ts` — existing test suite (must stay green)
- `packages/workspace/SYNC_ARCHITECTURE.md` — supervisor walkthrough docs to update
- `specs/20260427T010000-supervisor-redesign.md` — umbrella spec
- Commit `f58209c02` — the round-2 fixes that this step makes structurally robust
- [MDN: AbortController](https://developer.mozilla.org/en-US/docs/Web/API/AbortController)
- [MDN: AbortSignal.any](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal/any) — required for parent-child composition
- [Node setTimeout signal option](https://nodejs.org/api/timers.html#settimeoutcallback-delay-args) — signal-aware timer helper

## Out of scope for this step

- Decomposing `attach-sync.ts` into Connection/Sync/Presence/RPC files (Step 2-3)
- Wire boundary validation (Step 4)
- Per-call retry policy (Step 5)
- Observability (Step 6)
- Any public API change beyond adding optional `signal` to RPC call options

These are addressed in subsequent steps. Keeping Step 1 surgical means we ship the cancellation refactor in 1-2 days with high confidence, and the rest of the redesign builds on a solid cancellation foundation.
