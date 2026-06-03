# Whispering Cloud Sync and Account

**Date**: 2026-06-02
**Status**: Draft
**Owner**: Braden
**Branch**: worktree-bridge-cse_01UFYqY9a61xzPXdwtkgm93n

## One Sentence

Add optional Epicenter sign-in to Whispering that attaches cloud Yjs sync over its already-local-first workspace, surfaced from the sidebar footer and a Settings -> Account page, with recording audio kept device-local unless the user explicitly uploads it to R2.

## How to read this spec

```txt
Read first:
  One Sentence
  Current State
  The Inversion (why Whispering is not tab-manager)
  Target Shape
  Implementation Plan
  Success Criteria

Read if changing the architecture:
  Design Decisions
  Architecture
  Settings partition
  Audio blobs
  Edge Cases

Decide these:
  Open Questions
```

## Overview

Whispering is already a `@epicenter/workspace` Yjs app, but local-only: it persists to IndexedDB and same-device BroadcastChannel with no account, no keyring, and no relay. This spec adds an **optional** cloud layer: sign in with Epicenter, and the workspace (recording metadata, transcripts, transformations, and a curated subset of settings) syncs across devices through the existing `openCollaboration` relay. Audio files stay on the device that recorded them unless the user presses "Upload audio," which pushes the blob to R2.

## Motivation

### Current State

Whispering builds one module-singleton workspace and wires only same-device persistence (`apps/whispering/src/lib/whispering/whispering.tauri.ts:46`):

```ts
export function openWhispering() {
  const workspace = createWhispering();          // no keyring -> unencrypted

  const idb = attachIndexedDb(workspace.ydoc);   // local, plaintext
  attachBroadcastChannel(workspace.ydoc);        // same-device only

  return defineWorkspace({
    ...workspace,
    actions: defineActions({ ...workspace.actions, /* tauri md export */ }),
    whenReady: idb.whenLoaded,
  });
}

export const whispering = openWhispering();      // consumed everywhere as a singleton
```

Consumers read through a thin reactive state layer, not the doc directly:

```ts
// apps/whispering/src/lib/state/recordings.svelte.ts
const recordings = fromTable(whispering.tables.recordings);
// apps/whispering/src/lib/state/settings.svelte.ts
// single observer over whispering.kv (local or remote CRDT writes)
```

This creates the gap:

1. **No cross-device sync**: a recording made on the laptop never reaches the phone or desktop. BroadcastChannel is same-origin, same-device only.
2. **No account, no identity, no keyring**: nothing to scope or encrypt owner data with.
3. **No UI surface**: there is no sign-in control anywhere. The homepage has no top bar (it lives outside the `(config)` route group, so the persistent header never renders there).

### Desired State

```txt
Signed out (default, unchanged for existing users):
  local doc -> attachIndexedDb (plaintext) + BroadcastChannel    # works fully offline

Signed in (opt-in):
  owner doc -> attachLocalStorage (owner-partitioned, keyring-encrypted)
            -> openCollaboration (relay sync across devices)
  audio blobs stay local until "Upload audio" -> R2
```

Sign-in is additive. Whispering must keep working with no account, offline, forever.

## The Inversion: Whispering is not tab-manager

This is the load-bearing design fact. tab-manager and fuji are **auth-gated** (Shape A in `workspace-app-composition`): `createSession({ auth, build })` *owns* the workspace, so signed-out means `session.current === null` and the entire app is a sign-in wall.

Whispering is **local-first** (Shape B): the workspace is a module singleton that must exist with no account. So we cannot let `createSession` own the workspace. Instead:

```txt
tab-manager / fuji:   auth -> session -> workspace        (no auth, no workspace)
whispering:           workspace (always) ; auth -> sync   (sync is a detachable layer)
```

The consequence: there is an **active workspace** that is either the local doc (signed out) or an owner-scoped synced doc (signed in). They are *different Y.Docs* because encryption is fixed at construction (`createWhispering({ keyring })`) and local storage is partitioned by owner. Switching identity rebuilds the active workspace and migrates data once. The leverage point that keeps this contained: components already read through `$lib/state/*`, so only those few state modules (plus the singleton) need to follow the swap, not every component.

## Research Findings

### How Epicenter apps wire cloud sync

| App | Gating | Workspace owner | Local storage | Sync |
| --- | --- | --- | --- | --- |
| tab-manager | auth-gated | `createSession` build cb | `attachLocalStorage` (owner-partitioned) | `openCollaboration` |
| fuji | auth-gated | `createSession` build cb | `attachLocalStorage` | `openCollaboration` + child docs |
| **whispering (target)** | **optional** | **module singleton + reactive swap** | local plaintext OR owner-partitioned | `openCollaboration` when signed in |

**Key finding**: every existing synced app is auth-gated, so none of them model "optional sync over an always-on local doc." Whispering is the first. The reusable pieces (`createOAuthAppAuth`, `createSession`, `SignedIn`, `openCollaboration`, `attachLocalStorage`, `roomWsUrl`, `AccountPopover`) all transfer; the *composition* (active-workspace indirection + first-sign-in migration) is new.

**Implication**: we reuse `createSession` for the signed-in branch only, and place the local doc as the fallback when `session.current` is null.

### Reusable UI: `AccountPopover`

`packages/svelte-utils/src/account-popover/account-popover.svelte` is a drop-in: an icon button whose glyph reflects auth + sync status (Cloud / CloudOff / spinner), with a popover for identity, sync phase, reconnect, and sign-out. Props: `auth` (required), `collaboration` (optional slice with `status` / `onStatusChange` / `reconnect`), `syncNoun` (e.g. `"recordings"`), `onForgetDevice?`. Exported as `@epicenter/svelte/account-popover`.

The sync phases it renders come from `SyncStatus` (`packages/workspace/src/document/internal/sync-supervisor.ts`):

```ts
type SyncStatus =
  | { phase: 'offline' }
  | { phase: 'connecting'; retries: number; lastError?: SyncError }
  | { phase: 'connected' }
  | { phase: 'failed'; reason: SyncFailedReason };
```

### Platform DI already exists

Whispering selects browser-vs-Tauri implementations through `#platform/*` package.json subpath imports + the `tauri` vite condition. Auth storage and the OAuth launcher differ per platform, so they slot in as a new `#platform/auth` seam (`auth.tauri.ts` / `auth.browser.ts`), matching the existing `#platform/tauri` pattern.

## Design Decisions

| Decision | Class | Choice | Rationale |
| --- | --- | --- | --- |
| Gating model | 2 coherence | Optional, not gated | Whispering's identity is free, offline, local-first. Sync is additive. |
| Workspace lifecycle | 2 coherence | Active workspace = `session.current ?? localWhispering` | Local doc always exists; signed-in branch is a separate owner-scoped doc. |
| Where the swap is absorbed | 3 taste | In `$lib/state/*` + the `whispering` accessor | Components read through state modules; insulate them, not every call site. Revisit if a component reaches the doc directly. |
| Auth factory | 1 evidence | `createOAuthAppAuth` via `@epicenter/svelte/auth` | One blessed factory (verify against `packages/auth`). Needs a Whispering OAuth client id in `@epicenter/constants/oauth`. |
| UI placement | 2 coherence | Sidebar footer `AccountPopover` + Settings -> Account page | Footer is route-independent (renders on the bare homepage); Settings page is the discoverable canonical home. |
| Settings sync | 2 coherence | Per-key allowlist: sync portable prefs, exclude secrets + device-bound | API keys, shortcuts, selected mic are wrong to sync. (User decision.) |
| Audio blobs | 2 coherence | Stay local; opt-in per-recording upload to R2 | Audio is large; the relay/body model targets CRDT/text, not big binaries. (User decision.) |
| First sign-in data | 1 evidence | Migrate local rows/allowlisted KV into the owner doc once | Verify merge-vs-copy semantics against `createWorkspace` + actions during impl. |
| Audio encryption at rest | Deferred | Deferred | Client-side keyring-encrypt before R2 PUT is the ambition; plaintext-in-R2 is the cheap start. See Open Questions. |
| Tauri daemon mount | Deferred | Deferred | Headless background sync via `defineMount` is post-MVP. |

## Architecture

### Active workspace selection

```txt
                        auth.state
                            |
            +---------------+----------------+
            | signed-out                     | signed-in / reauth-required
            v                                v
   localWhispering (singleton)      createSession build:
     createWhispering()               createWhispering({ keyring: signedIn.keyring })
     attachIndexedDb (plaintext)      attachLocalStorage (owner-partitioned, encrypted)
     attachBroadcastChannel           attachBroadcastChannel
                                       openCollaboration(roomWsUrl(...))
            \                                /
             \                              /
              v                            v
        getActiveWhispering()  =  session.current ?? localWhispering
                            |
                            v
              $lib/state/recordings.svelte.ts
              $lib/state/settings.svelte.ts   (re-subscribe on swap)
                            |
                            v
                       components (unchanged)
```

### Sign-in flow

```txt
Step 1: User clicks sidebar AccountPopover -> "Sign in with Epicenter"
  auth.startSignIn()  (browser: redirect launcher; tauri: deep-link / OOB launcher)

Step 2: auth.state -> 'signed-in' (ownerId, keyring)
  createSession build() fires -> owner doc + attachLocalStorage + openCollaboration

Step 3: First time on this device with local data?
  migrate local rows + allowlisted KV into the owner doc (idempotent by id)

Step 4: getActiveWhispering() now returns the synced doc
  state modules re-subscribe; UI shows Cloud + "Connected"
```

### New files (mirrors fuji/tab-manager)

```txt
apps/whispering/src/lib/
  auth/
    auth.browser.ts      # createWebStoragePersistedAuthStorage + redirect launcher
    auth.tauri.ts        # file/Stronghold-backed storage + deep-link/OOB launcher
  session.svelte.ts      # createSession({ auth, build: openWhisperingSynced })
  whispering/
    whispering.synced.ts # owner-scoped: attachLocalStorage + openCollaboration
    active.svelte.ts     # getActiveWhispering() = session.current ?? localWhispering
package.json#imports
  "#platform/auth": { "tauri": "./src/lib/auth/auth.tauri.ts", "default": "./src/lib/auth/auth.browser.ts" }
```

## Settings partition (the KV allowlist)

`definition.ts` currently defines ~40 KV keys in one map. Split them:

```txt
syncedKv   (portable prefs): ui.*, transcription provider CHOICE, sound.*, output.*, transformation defaults
localKv    (excluded):       api-keys / provider secrets, shortcuts (local + global), selected audio device,
                             retention/cleanup that is device-specific
```

- The owner doc carries only `syncedKv`. `localKv` always lives in a device-local store (the local doc, or a dedicated always-local KV), regardless of sign-in state.
- `settings.svelte.ts` reads from both and merges; writes route to the correct store by key.
- This is the riskiest single refactor in the spec because a misclassified key either leaks a secret to the relay or pushes a device-bound setting to the wrong machine. Treat the allowlist as the review gate.

## Audio blobs (opt-in R2)

Audio lives in Dexie today (`$lib/services/blob-store`), separate from the Yjs metadata. Keep it there; add a pointer on the recording row.

```txt
recordings row gains:
  audioUpload: nullable({ status: 'uploaded', r2Key, bytes, uploadedAt })   # null = device-local only

Per recording:
  [Upload audio]  -> encode -> (encrypt?) -> PUT via API -> set audioUpload on row
On another device:
  audioUpload != null  -> [Download / Play] (GET from API)
  audioUpload == null  -> "Audio is on the device that recorded it"
```

New owner-scoped, bearer-authed routes in `packages/server` (consumed by `apps/api` worker) backed by an R2 bucket binding:

```txt
PUT  /api/owners/:ownerId/audio/:recordingId    # upload (presigned or proxied)
GET  /api/owners/:ownerId/audio/:recordingId    # download/stream
```

Billing note: R2 storage/egress is hosted-personal-cloud only; keep it in `apps/api/worker`, never in the shared library seam.

## Call sites: before and after

### The workspace accessor

**Before** (`apps/whispering/src/lib/whispering/whispering.tauri.ts:108`):

```ts
export const whispering = openWhispering();
```

**After** (local doc stays a singleton; add a reactive active accessor):

```ts
export const localWhispering = openWhispering();           // unchanged construction
// active.svelte.ts
export const getActiveWhispering = () => session.current?.whispering ?? localWhispering;
```

**Semantic shift to flag**: `whispering` was a stable import. Direct `import { whispering }` users must move to `getActiveWhispering()` (a reactive read). Grep for `whispering.tables`, `whispering.kv`, `whispering.actions` outside `$lib/state/*`; each is a call site that must go through the accessor or be proven local-only.

### Recordings state binding

**Before** (`apps/whispering/src/lib/state/recordings.svelte.ts`):

```ts
const recordings = fromTable(whispering.tables.recordings);
```

**After**:

```ts
// re-derive when the active workspace swaps (sign-in / sign-out)
const recordings = $derived(fromTable(getActiveWhispering().tables.recordings));
```

**Semantic shift to flag**: bindings become `$derived` over the active workspace. On swap, subscriptions must dispose and re-create cleanly (no leaked observers from the previous doc).

## Implementation Plan

### Phase 1: Auth wiring (no sync yet)

- [x] **1.1** Register a Whispering OAuth client id in `@epicenter/constants/oauth` (`EPICENTER_WHISPERING_OAUTH_CLIENT_ID = 'epicenter-whispering'` + `EPICENTER_WHISPERING_TAURI_OAUTH_REDIRECT_URI` + a `buildTrustedOAuthClients` entry mirroring Fuji's web+Tauri shape).
- [x] **1.2** Add `#platform/auth` seam: `src/lib/platform/auth.browser.ts` (web-storage persisted auth + `createBrowserOAuthLauncher`) and `auth.tauri.ts` (deep-link launcher, mirrors fuji). Added `PlatformAuth` to `platform/types.ts`, the `#platform/auth` import map, and deps (`@epicenter/auth`, `@tauri-apps/plugin-deep-link`). Native deep-link wiring landed too: Cargo `tauri-plugin-deep-link` + single-instance `deep-link` feature, `lib.rs` plugin init + `register_all()`, `tauri.conf.json` `epicenter-whispering` scheme, capabilities `deep-link:default` + `opener:allow-open-url`. TS typecheck green; **Rust `cargo check` still to run.**
- [x] **1.3** `auth = createOAuthAppAuth(...)` is constructed in both seam files via `@epicenter/svelte/auth`. (Consumed by Phase 2's session + the UI in 1.4/1.5.)
- [ ] **1.4** Drop `AccountPopover` into `VerticalNav.svelte` footer (after Theme, before Minimize) with `syncNoun="recordings"`; add a mobile equivalent entry to `BottomNav` / settings.
- [ ] **1.5** Add Settings -> Account page (`(config)/settings/account`) + `SidebarNav` entry: identity, sync status, sign in/out, forget device.
- [ ] **1.6** Verify: signed-in identity shows, signed-out app is byte-for-byte the current behavior.

### Phase 2: Optional synced workspace

- [ ] **2.1** Make `createWhispering` accept an optional `keyring` and thread it to `createWorkspace`.
- [ ] **2.2** `whispering.synced.ts`: owner-scoped doc with `attachLocalStorage` + `openCollaboration` + `roomWsUrl`.
- [ ] **2.3** `session.svelte.ts`: `createSession({ auth, build })` returning the synced workspace + collaboration.
- [ ] **2.4** `active.svelte.ts`: `getActiveWhispering()`; migrate `$lib/state/*` to `$derived` over it.
- [ ] **2.5** Wire `collaboration` into the footer `AccountPopover` so sync phase renders.

### Phase 3: Settings partition

- [ ] **3.1** Split KV into `syncedKv` / `localKv` per the allowlist; owner doc carries only `syncedKv`.
- [ ] **3.2** Update `settings.svelte.ts` to read both and route writes by key.
- [ ] **3.3** Review gate: confirm no secret or device-bound key is in `syncedKv`.

### Phase 4: First-sign-in migration

- [ ] **4.1** On first owner build with existing local data, copy local rows + allowlisted KV into the owner doc, idempotent by id.
- [ ] **4.2** Mark migrated; do not re-run. Verify no duplication on repeat sign-in.

### Phase 5: Audio to R2 (opt-in)

- [ ] **5.1** Add `audioUpload` column (nullable pointer) with a table migration.
- [ ] **5.2** R2 bucket binding + owner-scoped PUT/GET routes in `packages/server` / `apps/api/worker`.
- [ ] **5.3** Per-recording "Upload audio" action + UI; cross-device "Download / Play" vs "audio on original device."
- [ ] **5.4** Decide + implement audio-at-rest encryption (see Open Questions).

### Phase 6 (deferred): Tauri daemon mount

- [ ] **6.1** `workspaces/whispering/daemon.ts` via `defineMount` for headless background sync.

## Edge Cases

### Sign in on a second device with no local data
1. Owner doc is empty locally; relay replays the owner's state.
2. Recordings appear with transcripts; rows whose `audioUpload` is null show "audio on original device."
3. Expected: metadata/transcripts present, audio absent until uploaded.

### Sign out
1. `session.current` -> null; synced doc disposed.
2. `getActiveWhispering()` falls back to `localWhispering`.
3. Expected: local data (whatever the local doc holds) remains; no wipe. Synced-only data is not in the local doc. See Open Questions on local/owner doc reconciliation.

### Reauth-required (token expired)
1. `auth.state` -> `reauth-required`; `createSession` keeps the payload mounted (same owner).
2. Local edits keep working; relay paused.
3. `AccountPopover` shows the failed/offline glyph + Reconnect. Expected: no data loss.

### Sign in as a different account on the same device
1. Owner changes; `createSession` disposes and rebuilds for the new owner.
2. `attachLocalStorage` is owner-partitioned, so account B never sees account A's local owner store.
3. Expected: no cross-account contamination. The first-sign-in migration must key off the *local* doc, not a previous owner's doc.

## Open Questions

1. **Local doc vs owner doc reconciliation after sign-out.**
   - Options: (a) signed-out always reads `localWhispering`, and signed-in work lives only in the owner doc (sign-out "hides" synced-only recordings until you sign back in); (b) mirror owner writes back into the local doc so signed-out keeps a read-only copy; (c) after first sign-in, treat the owner doc as the only doc on that device and never fall back.
   - **Recommendation**: (a) for MVP. It is the simplest honest model and matches "sync is an optional layer." Revisit if users find disappearing-on-sign-out surprising. Leave open.

2. **Audio encryption at rest in R2.**
   - Options: (a) plaintext in R2 (server-readable, simplest, consistent with today's plaintext-body gap); (b) client-side keyring-encrypt the whole blob before PUT and decrypt on GET (E2E, but no range/streaming).
   - **Recommendation**: (b) whole-blob encrypt for short recordings, since the keyring is already in hand and this is someone's voice. Confirm against the encryption skill and relay/body model. Leave open.

3. **Mobile / narrow-viewport placement.**
   - The sidebar footer is desktop-only; `BottomNav` has four fixed slots.
   - **Recommendation**: rely on the Settings -> Account page on mobile; optionally a small account glyph in `BottomNav`. Defer the exact mobile chrome.

4. **OAuth launcher on Tauri.**
   - Redirect vs deep-link vs OOB. tab-manager uses an extension launcher; whispering is Tauri.
   - **Recommendation**: deep-link callback if a scheme is registered, else OOB paste. Verify against `packages/auth` machine-auth + browser launchers. Leave open.

## Success Criteria

- [ ] Signed-out Whispering is behaviorally identical to today (offline, no account, local IDB + BroadcastChannel).
- [ ] Sign-in works from both the sidebar footer popover and Settings -> Account, on web and Tauri.
- [ ] A recording made on device A appears (metadata + transcript) on device B after sign-in; sync phase shows "Connected."
- [ ] No secret or device-bound setting (API keys, shortcuts, selected mic) ever enters the synced doc.
- [ ] "Upload audio" makes a recording's audio playable on another signed-in device; un-uploaded recordings clearly read as device-local.
- [ ] First sign-in migrates existing local data once with no duplication.
- [ ] `bun run --filter @epicenter/whispering check` passes; signed-out smoke test green.

## References

- `apps/whispering/src/lib/whispering/whispering.tauri.ts:46` - current local-only `openWhispering`.
- `apps/whispering/src/lib/workspace/definition.ts` - tables + ~40 KV keys to partition.
- `apps/whispering/src/lib/state/recordings.svelte.ts`, `settings.svelte.ts` - the swap-absorbing layer.
- `apps/whispering/src/routes/(app)/_components/VerticalNav.svelte:77` - sidebar footer (popover home).
- `apps/whispering/src/routes/(app)/(config)/settings/SidebarNav.svelte` - add Account entry.
- `apps/tab-manager/src/lib/session.svelte.ts` - `createSession` + `openCollaboration` reference wiring.
- `apps/tab-manager/src/lib/platform/auth/auth.ts` - persisted-auth storage + launcher reference.
- `apps/fuji/src/lib/workspace/browser.ts` - `attachLocalStorage` + `openCollaboration` `wire()` pattern.
- `packages/svelte-utils/src/account-popover/account-popover.svelte` - drop-in sync/account UI.
- `packages/svelte-utils/src/session.svelte.ts` - `createSession` + `SignedIn` contract.
- `packages/workspace/src/document/{open-collaboration,attach-local-storage,transport}.ts` - sync primitives.
- `.claude/skills/auth/SKILL.md`, `workspace-app-composition` - composition rules (Shape A vs B).
