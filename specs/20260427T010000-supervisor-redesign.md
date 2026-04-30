# Supervisor redesign: from god function to composed primitives

**Date:** 2026-04-27
**Status:** Draft
**Author:** AI-assisted (Braden + Claude)
**Branch:** `post-pr-1705-cleanup`

## One-sentence thesis

`attachSync` is a 1080-line god function whose recurring bugs trace to one root cause (hand-rolled cancellation across an over-large surface), so the redesign decomposes it into four independent primitives unified by `AbortSignal`, with optional features typed honestly and wire data validated at the boundary.

## Overview

This is the umbrella spec for a multi-step redesign of `packages/workspace/src/document/attach-sync.ts`. Each step is independently shippable. After Tier 1 (steps 1-3) the architecture is sound. After Tier 2 (steps 4-6) it is production-grade. Tier 3 (steps 7-9) is deferred until the product asks.

Per-step implementation specs are written just-in-time, immediately before each step is implemented, so they reflect what we learned from the previous step rather than what we guessed in advance. This document is the single durable reference for the whole journey.

## Motivation

### The bug pattern

Across one extended audit conversation, the supervisor in `attach-sync.ts` produced four P0 bugs in a row:

1. `goOffline()` then `reconnect()` could silently park the supervisor offline (`reconnect` early-returned because `currentSupervisorPromise` was still set, never re-flipping `desired`).
2. `whenConnected` could hang forever if the first handshake never landed.
3. `rpc()` calls during teardown leaked `setTimeout` entries in `pendingRequests`.
4. The fix for bug #1 was itself incomplete: the same race was reachable through a status subscriber calling `reconnect()` from inside `runLoop`'s synchronous offline tail.

Each bug was real. Each fix was correct. But the *cadence* of "find a bug, fix it, re-audit, find another bug" is the signal that matters: the supervisor's complexity exceeds what humans verify reliably.

### The root cause

`runId` is hand-rolled cancellation. Every `await` in `runLoop` is followed by:

```ts
if (cancelled(myRunId)) continue;
```

If you forget that line after any await, you race. There is no compiler enforcement, no structural guarantee. The four state flags (`runId`, `desired`, `torn`, `currentSupervisorPromise`) describe what is fundamentally one concept ("should this work continue?") through four orthogonal mechanisms. Every fix to one risks introducing inconsistency with the others.

### Other architectural concerns surfaced by the audit

Beyond cancellation, the same audit pass identified:

- **Wire trust asymmetry.** Awareness frames are validated per-field with arktype (good); RPC results and `system.describe` responses are cast unvalidated (`as TMap[TAction]['output']`). A buggy peer returning `null` from `system.describe` crashes the consumer downstream on `Object.entries(null)`.
- **God function boundaries are conventional, not structural.** Five concerns (wire, sync protocol, presence, RPC, system injection) share one closure. Adding a feature to one risks bleeding into the others. The fact that we keep finding edge cases at the seams between them is not anyone's fault; it's the surface being bigger than any single mind can hold.
- **RPC death on every reconnect.** `clearPendingRequests()` runs at every supervisor iteration restart. A 200ms WebSocket blip aborts every in-flight RPC with `Disconnected`. For short, side-effecting actions this is fine; for long, idempotent actions it is brutal.
- **Optional features pretend to always exist.** `sync.peers()` returns an empty `Map` if no `device` was passed. There is no type-level signal that "you forgot to configure presence." The `describePeer(sync, deviceId)` proxy returns `PeerNotFound` against a presence-less sync, which is technically correct but misleading.
- **`whenConnected` and `whenDisposed` leak supervisor internals.** Consumers want "is the workspace usable" or "is the wire responsive right now," not "did the first STEP2 frame arrive." The current API exposes the implementation detail because the implementation IS the API.

## Three guiding principles

These three properties are non-negotiable. Anything that does not serve them is not part of this redesign.

1. **Locally reasonable.** Any subsystem can be understood and verified without holding the others in your head. The cognitive surface of any one file is small enough that a careful reader can prove it correct.
2. **Honestly typed.** What the type says exists, exists. Optional features are typed as optional. Wire data is validated at the boundary; in-process types are trusted.
3. **Structurally robust.** Bugs are caught at compile time or by primitives, not by manual checks. Cancellation, lifecycle, and pending state are each one mechanism, not several.

## End-state architecture

Post-Tier 2, the file structure is:

```
packages/workspace/src/document/
├── attach-sync.ts           ~80 lines  (the composer / facade)
├── connection.ts           ~250 lines  (wire: WS, backoff, liveness, status)
├── sync-protocol.ts        ~150 lines  (STEP1/STEP2/UPDATE handling)
├── presence.ts             ~200 lines  (awareness: peers, find, observe)
└── rpc-channel.ts          ~300 lines  (RPC: call, dispatch, system.* injection)
```

Each file owns one concern. Each file is independently testable with a fake `Connection`. Each subsystem owns its own teardown via the master `AbortSignal`.

Public API after the restructure:

```ts
const sync = attachSync({
  doc: { ydoc, actions },
  url,
  device,                          // optional
  getToken,                        // optional
  waitFor,                         // optional
  signal,                          // optional, user-controlled lifetime
});

// Always present
sync.connection                    // status, signal, lifecycle
sync.protocol                      // whenSynced

// Present iff `device` was passed
sync.presence?.peers()
sync.presence?.find(deviceId)
sync.presence?.observe(cb)

// Present iff `actions` was passed
sync.rpc?.call(target, path, input, opts)
```

Optional features that did not exist (because they were not configured) are `undefined` instead of "always returns empty." TypeScript catches the misconfiguration that today is a silent runtime degradation.

## The 9 steps

Each step is sized 1-7 days, ordered by dependency, and independently shippable. Tier numbering matches the priority discussion: Tier 1 must be done; Tier 2 should be done; Tier 3 is deferred.

### Tier 1 — Foundation

#### Step 1: AbortSignal-ify cancellation

Replace `runId`, `torn`, `desired`, and `currentSupervisorPromise` with one `AbortController` per `attachSync` call. Every internal `await` uses `{ signal }` and naturally throws on abort. `goOffline()` aborts a child controller; `reconnect()` recreates it. Dispose aborts the master controller.

No public API change. ~80 lines of state-management code disappear. The bug class that produced the four P0s in this conversation becomes structurally impossible.

**Detailed spec:** `specs/20260427T020000-supervisor-redesign-step-1-abortsignal.md`

#### Step 2: Extract `Connection`

Pull the WebSocket lifecycle (open, close, retry, backoff, liveness, status emitter) out of `attachSync` into a standalone `createConnection(config)` function. It exposes `send()`, `onMessage()`, `status`, `onStatusChange()`, and `signal`. Nothing else.

No public API change for `attachSync` consumers. ~300 lines move from `attach-sync.ts` to `connection.ts`. Sets the foundation for steps 3-5: each subsystem will consume a `Connection`.

#### Step 3: Extract `SyncProtocol`, `Presence`, `RpcChannel`

Three further extractions. `attachSyncProtocol(connection, ydoc)` handles STEP1/STEP2/UPDATE. `createPresence(connection, ydoc, device)` handles awareness. `createRpcChannel(connection, actions)` handles RPC.

This is the biggest API change of the redesign: `sync.peers()` becomes `sync.presence?.peers()`; `sync.rpc(...)` becomes `sync.rpc?.call(...)`. Five apps and the CLI update. Each call site is a 5-line change; the win is that optional features become honestly typed.

After this step, the architecture is sound. Tier 1 is complete.

### Tier 2 — Correctness and honesty

#### Step 4: Wire boundary validation

Every byte that arrives over the wire gets validated against a schema before the typed code touches it.

- RPC inbound: validate `input` against the action's declared `input` schema before invoking the handler.
- RPC outbound: if the action declares an `output` schema (new optional field), validate the response.
- `system.describe` response: validate against an `ActionManifest` schema on receive.
- Awareness: already done; no change.

New error variant: `RpcError.InvalidPayload`. Backwards compatible: handlers without explicit `input` schemas accept anything (current behavior).

#### Step 5: Per-call RPC retry policy

Add `retryPolicy` to RPC call options. Default is current behavior (fail-fast on disconnect). Opt-in to "hold across reconnects" or "retry N times" per call.

```ts
await macbook.tabs.close({ ids: [1] });             // fail-fast (default)
await macbook.ai.summarize(input, {                  // hold across reconnect
  retryPolicy: { acrossReconnects: true, maxAttempts: 3 }
});
```

Action authors pick the policy at the call site. Pending RPC entries gain a `policy` field; on disconnect, entries with `acrossReconnects` survive the supervisor restart.

#### Step 6: Structured observability

Each subsystem emits structured events through a logger. Today, logging is two `log.warn` calls. After: every meaningful state transition is an event.

- Connection: `connection.opened`, `connection.closed`, `connection.retry_scheduled`, `connection.token_refreshed`
- Sync: `sync.handshake_started`, `sync.handshake_completed`, `sync.update_applied`
- Presence: `presence.peer_joined`, `presence.peer_left`, `presence.state_updated`
- RPC: `rpc.call_started`, `rpc.call_succeeded`, `rpc.call_failed`, `rpc.dispatch_succeeded`, `rpc.dispatch_failed`

Optional `tracingId` correlation across events for one RPC call. Tests can subscribe to events for verification, replacing brittle "wait for state" patterns.

After Tier 2, the redesign is production-grade.

### Tier 3 — Deferred

These steps are real architectural improvements but speculative absent product demand. Spec them only when their deferral trigger fires.

#### Step 7: Backpressure on `pendingRequests`

Cap `pendingRequests` size; reject overflow with `RpcError.QueueFull`. Today an offline client firing 10K RPC calls leaks them all into the map.

**Deferral trigger:** anyone reports memory growth from offline RPC calls.

#### Step 8: Wire schema versioning

Every wire shape (`PeerDevice`, `ActionMeta`, RPC envelope) carries `_v`. Handshake negotiates a common version. Receivers reject or downgrade unknown versions.

**Deferral trigger:** first time we want to make a breaking wire change OR ship to multiple deployment cohorts.

#### Step 9: Permission model

Per-action authorization. `defineMutation({ ..., authorize: ({ caller }) => caller.role === 'admin' })`. Today every authenticated peer can call every action.

**Deferral trigger:** multi-user product feature (today's model is single-user multi-device, where every device IS you).

## Dependency graph

```
Step 1 (AbortSignal)
  │
  ▼
Step 2 (Connection)
  │
  ▼
Step 3 (Sync + Presence + RPC extraction)
  │       │       │
  │       │       ▼
  │       │     Step 4 (Wire validation)   ← needs RpcChannel
  │       │       │
  │       │       ▼
  │       │     Step 5 (Retry policy)      ← needs RpcChannel
  │       │
  │       ▼
  │     (independent)
  ▼
Step 6 (Observability)  ← can land in parallel with 4/5

Step 7-9: independent of each other; need Step 3 done.
```

Step 6 can be drafted and landed in parallel with Steps 4 and 5 once Step 3 is done. Steps 7-9 wait for their triggers.

## Cadence

- **Today:** umbrella spec (this document) + Step 1 spec.
- **Each step:** detailed spec drafted just-in-time, implemented in 2-5 atomic commits, umbrella revised if learnings demand.
- **Per-step PR:** one PR per step (or one bundled push, depending on workflow). Within a step, split commits by natural seam.
- **Per-tier checkpoint:** at the end of each tier, re-audit. The supervisor audit prompt that found the original P0s is preserved in the conversation history; rerun it against the post-tier state.

This document is durable. It is revised, never replaced, as the work progresses. Step-specific specs are ephemeral: written immediately before implementation, marked Implemented when complete.

## What we are explicitly NOT doing

These are real architectural improvements that someone might propose during this work. They are out of scope. Documenting them here so future readers understand they were considered, not forgotten.

| Not doing | Why |
|---|---|
| Multi-connection / multi-provider failover | Y.Doc supports multiple providers natively; `attachSync` only needs to be a good single provider. Adding multi-connection logic doubles the surface for marginal benefit. |
| Plugin / dynamic actions tree | Closure-captured snapshot is the right call. Dynamic actions add reactive state to dispatch, which then needs synchronization, validation, garbage collection. Massive surface for marginal benefit. |
| End-to-end encryption between peers | Today encryption is per-doc (you trust the server with metadata, not contents). E2E between peers is a different threat model. Build only when the product demands it. |
| Codec abstraction (swap WebSocket for WebRTC) | Premature. The wire is WebSocket-shaped; pretending otherwise adds layers without callers. |
| Separate `system.*` wire channel | Discussed in audit. Reserved namespace + `Object.freeze` is sufficient. A separate wire channel duplicates RPC infrastructure for marginal isolation. |
| Replacing `whenConnected` / `whenDisposed` with reactive primitives | Tempting but out of scope; the existing Promise contract is fine, just leaky. Step 3 makes it less leaky by reorganizing. |

## Stopping points

If we stop after any step, the system is better than it was. Concrete stopping points:

- **After Step 1:** the bug class that triggered this work is structurally impossible. Even if we never decompose the file, the architecture is much more robust.
- **After Step 3:** the architecture is sound. Each subsystem is testable in isolation. Optional features are typed honestly.
- **After Step 6:** production-grade. Wire data is validated, RPCs survive blips when authors opt in, every state transition is observable.
- **Tier 3 only on demand.**

Most likely stopping point in practice: after Step 6, on the assumption that Tier 3's triggers will not fire in the foreseeable future.

## Success criteria for the redesign as a whole

- [ ] All four P0 bugs from the audit are structurally impossible (Step 1).
- [ ] The supervisor file is split into four ~250-line files plus an ~80-line composer (Steps 2-3).
- [ ] Optional features are typed as `undefined` when not configured (Step 3).
- [ ] Inbound RPC validates input against the handler's declared schema (Step 4).
- [ ] Long-running RPCs can opt into surviving brief network failures (Step 5).
- [ ] Every state transition emits a structured event (Step 6).
- [ ] All 5 apps and the CLI consume the new API (Step 3).
- [ ] Test suite remains green throughout; total tests stay >= current count (currently 700).

## References

- `packages/workspace/src/document/attach-sync.ts` — the file being decomposed
- `packages/workspace/src/document/attach-awareness.ts` — already separate, will be consumed by the new `presence.ts`
- `packages/workspace/src/rpc/peer.ts` — RPC proxy surface; depends on `SyncAttachment` shape
- `packages/workspace/src/shared/actions.ts` — Action types, `SystemActions`
- `packages/workspace/SYNC_ARCHITECTURE.md` — current architecture doc; will need updating after each step
- `specs/20260426T130000-fold-awareness-into-sync.md` — the prior consolidation that this redesign builds on
- `specs/20260427T020000-supervisor-redesign-step-1-abortsignal.md` — Step 1 detailed spec (next document)
