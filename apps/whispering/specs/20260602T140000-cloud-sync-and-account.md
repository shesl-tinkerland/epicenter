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
  Settings (device-local in v1)
  Audio blobs
  Edge Cases

Decide these:
  Open Questions
```

## Overview

Whispering is already a `@epicenter/workspace` Yjs app, but local-only: it persists to IndexedDB and same-device BroadcastChannel with no account, no keyring, and no relay. This spec adds an **optional** cloud layer: sign in with Epicenter, and the workspace (recording metadata, transcripts, transformations) syncs across devices through the existing `openCollaboration` relay. Settings stay device-local in v1. Audio files stay on the device that recorded them unless the user presses "Upload audio," which pushes the blob to R2.

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

The consequence: the workspace is either the local doc (signed out) or an owner-scoped synced doc (signed in). They are *different Y.Docs* because encryption is fixed at construction (`createWhispering({ keyring })`) and local storage is partitioned by owner. Crucially, **both can be constructed synchronously at boot**: the keyring lives in `PersistedAuth` and `auth.state` is hydrated synchronously from localStorage at construction (`persisted-auth-storage.ts` reads `initial` once, sync), so the signed-in branch is *not* async. The seam reads `auth.state` once at boot, builds the local or synced doc, and exports `whispering` as a **stable module singleton** (data still loads async behind the existing `whenReady` gate, exactly as today). Signing in or out, or switching owner, triggers `window.location.reload()` so the next boot rebuilds the right doc. This keeps the singleton stable: the 6 `$lib/state` modules and their ~70 importers are UNCHANGED (no context migration, no reactive accessor, no `$derived` over a swapping doc). We deliberately do NOT copy fuji's `createSession` + context pattern: fuji needs it because its workspace does not exist when signed out, but Whispering's always does, so a boot-time pick plus reload is the smaller, honest fit (verified against the auth/workspace primitives and grilled with a second model).

## Research Findings

### How Epicenter apps wire cloud sync

| App | Gating | Workspace owner | Local storage | Sync |
| --- | --- | --- | --- | --- |
| tab-manager | auth-gated | `createSession` build cb | `attachLocalStorage` (owner-partitioned) | `openCollaboration` |
| fuji | auth-gated | `createSession` build cb | `attachLocalStorage` | `openCollaboration` + child docs |
| **whispering (target)** | **optional** | **module singleton; doc chosen at startup from auth, reload on auth change** | local plaintext OR owner-partitioned | `openCollaboration` when signed in |

**Key finding**: every existing synced app is auth-gated, so none of them model "optional sync over an always-on local doc." Whispering is the first. The reusable pieces (`createOAuthAppAuth`, `createSession`, `SignedIn`, `openCollaboration`, `attachLocalStorage`, `roomWsUrl`, `AccountPopover`) all transfer; the *composition* (startup doc selection by auth + reload-on-auth-change + first-sign-in migration) is new.

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
| Workspace lifecycle | 2 coherence | Doc chosen once at startup from `auth.state`; reload on sign-in/out | Local doc always exists; signed-in branch is a separate owner-scoped doc. A reload (not a live swap) means nothing is mounted when the doc is picked. |
| Live in-place swap | 2 coherence | Refused: reload on auth change instead | Deletes the reactive accessor, the `$lib/state` `$derived` migration, and the leaked-observer risk. `$lib/state/*` keeps importing the `whispering` singleton unchanged. |
| Both docs always alive | 2 coherence | Refused: mutually exclusive (overlap only during migration) | Keeping the local doc alive while signed in buys nothing: the state-layer read still switches on logout, which needs reload-or-context regardless. The only design that removes the switch (always read local, mirror to synced) keeps ALL data PLAINTEXT on disk, defeating the encrypted store. One doc at a time + reload is leaner and safer. |
| Auth factory | 1 evidence | `createOAuthAppAuth` via `@epicenter/svelte/auth` | One blessed factory (verify against `packages/auth`). Needs a Whispering OAuth client id in `@epicenter/constants/oauth`. |
| UI placement | 2 coherence | Sidebar footer `AccountPopover` + Settings -> Account page | Footer is route-independent (renders on the bare homepage); Settings page is the discoverable canonical home. |
| Settings sync | 2 coherence | Portable KV syncs; secrets + device-bound stay local | The existing two-store split already IS the allowlist. `whispering.kv` (sound, ui, transcription model choice, in-window shortcuts, recording.mode) rides the synced ydoc and roams across devices when signed in; `deviceConfig` (API keys, selected mic, global OS shortcuts, model paths) lives in separate `localStorage` and never syncs. No new split, no Phase 3; `settings.svelte.ts` is unchanged. |
| Audio blobs | 2 coherence | Stay local; opt-in per-recording upload to R2 | Audio is large; the relay/body model targets CRDT/text, not big binaries. (User decision.) |
| First sign-in data | 1 evidence | Migrate local rows/allowlisted KV into the owner doc once | Verify merge-vs-copy semantics against `createWorkspace` + actions during impl. |
| Audio encryption at rest | Deferred | Deferred | Client-side keyring-encrypt before R2 PUT is the ambition; plaintext-in-R2 is the cheap start. See Open Questions. |
| Tauri daemon mount | Deferred | Deferred | Headless background sync via `defineMount` is post-MVP. |

## Architecture

### Startup doc selection (no live swap)

```txt
            app startup: read persisted auth.state
                            |
            +---------------+----------------+
            | signed-out                     | signed-in / reauth-required
            v                                v
   build LOCAL doc (sync)            await session (ownerId, keyring), build SYNCED doc
     createWhispering()               createWhispering({ keyring: signedIn.keyring })
     attachIndexedDb (plaintext)      attachLocalStorage (owner-partitioned, encrypted)
     attachBroadcastChannel           attachBroadcastChannel
                                       openCollaboration(roomWsUrl(...))
            \                                /
             \                              /
              v                            v
          export const whispering    (a plain singleton, picked once at startup)
                            |
                            v
              $lib/state/* import it directly   (UNCHANGED from today)
                            |
                            v
                       components (unchanged)

  on sign-in completion / sign-out:  window.location.reload()
     -> next startup re-runs this selection against the new auth.state
```

### Sign-in flow

```txt
Step 1: User clicks sidebar AccountPopover -> "Sign in with Epicenter"
  auth.startSignIn()  (browser: redirect launcher; tauri: deep-link launcher)

Step 2: auth completes -> auth.state becomes 'signed-in' (ownerId, keyring), persisted

Step 3: window.location.reload()

Step 4: next startup sees signed-in auth -> builds the owner doc
  (createSession build -> attachLocalStorage + openCollaboration).
  First time on this device with local data? migrate local rows into the
  owner doc once (idempotent by id). UI shows Cloud + "Connected".
```

### New files (mirrors fuji/tab-manager)

```txt
apps/whispering/src/lib/
  platform/
    auth.browser.ts      # DONE: persisted web storage + shared browser redirect launcher
    auth.tauri.ts        # DONE: persisted storage + shared createTauriDeepLinkOAuthLauncher
  session.svelte.ts      # TODO: createSession({ auth, build: openWhisperingSynced })
  whispering/
    whispering.synced.ts # TODO: owner-scoped: createWhispering({ keyring }) + attachLocalStorage + openCollaboration
    whispering.{tauri,browser}.ts  # MODIFY: pick local vs synced at startup from auth.state; export `whispering`
package.json#imports
  "#platform/auth": { "tauri": "./src/lib/platform/auth.tauri.ts", "default": "./src/lib/platform/auth.browser.ts" }  # DONE
```

No `active.svelte.ts` and no `getActiveWhispering`: reload-on-auth means the doc is picked once where `whispering` is exported, so there is no accessor and no `$lib/state` migration.

## Settings (portable prefs sync; secrets and device-bound stay local)

The allowlist already exists, physically, as two separate stores. There is no Phase 3 split to do and `settings.svelte.ts` is unchanged.

```txt
deviceConfig  (localStorage "whispering.device.*", a SEPARATE store)   NEVER syncs
  apiKeys.* (secrets) · apiEndpoints.* · recording.cpal/navigator.deviceId (the MIC)
  · recording bitrate/sampleRate · transcription.*.modelPath/baseUrl
  · localModelUnloadPolicy · shortcuts.global.* (OS shortcuts)
        ^ definition.ts: "should NEVER sync across devices"

whispering.kv  (the workspace ydoc)                                    SYNCS when signed in
  sound · output · ui · dataRetention · recording.mode (manual/vad)
  · transcription.service + per-provider model + language + prompt
  · transformation.selectedId · analytics.enabled · shortcut.* (IN-WINDOW only)
```

Every dangerous value (provider API keys, selected mic, global OS shortcuts, model paths) is already in `deviceConfig`, which sign-in never touches: it is a plain `createPersistedMap` over `localStorage`, not part of any Y.Doc. The workspace KV holds genuinely portable preferences, and `settings.svelte.ts` already reads it through an observer whose own comment says "local writes OR remote sync": that KV was built to sync. So when signed in, those portable prefs ride the encrypted owner doc and roam across devices. That is desirable and free; the only mildly-device-y items that roam are the in-window (window-focused) shortcuts, which is benign.

The earlier "sync nothing from settings / defer a per-key allowlist (Phase 3)" framing was inaccurate: it described a single-doc world that the existing `deviceConfig` vs `whispering.kv` split already moved past. There is nothing to defer.

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

### The workspace export

**Before** (`apps/whispering/src/lib/whispering/whispering.tauri.ts:108`):

```ts
export const whispering = openWhispering();   // always the local doc
```

**After** (startup picks local vs synced from auth; the import stays stable):

```ts
// signed out -> local doc (today's construction)
// signed in  -> synced doc built from the synchronously-cached keyring in auth.state
export const whispering = openActiveWhispering();   // sync, chosen once at boot
```

**Semantic shift to flag**: none for consumers. Construction stays synchronous (the keyring is cached in `auth.state`); data still loads async behind the existing `whenReady` gate. `whispering` remains a plain stable import, so `$lib/state/*` and every component are UNCHANGED: no reactive accessor, no `$derived` over a swapping doc, no observer teardown. Identity changes are handled by a reload, not an in-place swap.

### Recordings state binding

Unchanged from today:

```ts
const recordings = fromTable(whispering.tables.recordings);
```

With reload-on-auth there is no live swap, so no `$derived` rewrap and no leaked-observer risk.

## Implementation Plan

### Phase 1: Auth wiring (no sync yet)

- [x] **1.1** Register a Whispering OAuth client id in `@epicenter/constants/oauth` (`EPICENTER_WHISPERING_OAUTH_CLIENT_ID = 'epicenter-whispering'` + `EPICENTER_WHISPERING_TAURI_OAUTH_REDIRECT_URI` + a `buildTrustedOAuthClients` entry mirroring Fuji's web+Tauri shape).
- [x] **1.2** Add `#platform/auth` seam: `src/lib/platform/auth.browser.ts` (web-storage persisted auth + `createBrowserOAuthLauncher`) and `auth.tauri.ts` (deep-link launcher, mirrors fuji). Added `PlatformAuth` to `platform/types.ts`, the `#platform/auth` import map, and deps (`@epicenter/auth`, `@tauri-apps/plugin-deep-link`). Native deep-link wiring landed too: Cargo `tauri-plugin-deep-link` + single-instance `deep-link` feature, `lib.rs` plugin init + `register_all()`, `tauri.conf.json` `epicenter-whispering` scheme, capabilities `deep-link:default` + `opener:allow-open-url`. TS typecheck green; **Rust `cargo check` still to run.**
- [x] **1.3** `auth = createOAuthAppAuth(...)` is constructed in both seam files via `@epicenter/svelte/auth`. (Consumed by Phase 2's session + the UI in 1.4/1.5.)
- [x] **1.4** `AccountPopover` mounted as the first `VerticalNav.svelte` footer item (route-independent, so it renders on the bare home page) with `syncNoun="recordings"`; `collaboration`/`onForgetDevice` omitted until sync lands. NOTE: rendered as the shared icon-only pill; a full-width labeled footer row is deferred polish (mobile `BottomNav` entry still TODO, see Open Question 3).
- [x] **1.5** Added Settings -> Account page (`(config)/settings/account/+page.svelte`) + `SidebarNav` entry. Built directly against the `#platform/auth` client (no popover indirection on the page): identity (email via `/api/session`), sign in/out, reauth. Forget-device + live sync status deferred to Phase 2 (need `wipe()` + `collaboration`); page shows an honest "sync not on yet" note.
- [x] **1.6** Verified statically: `typecheck` 0 errors, web `build` green (browser condition resolves the `#platform/auth` seam + `account-popover` + new page). Blast radius is 3 UI files only; no workspace/state/doc files touched, so the signed-out path is structurally unchanged. STILL TODO: live click-through sign-in and the Tauri deep-link round-trip (needs a desktop build + running OAuth backend + account).

### Phase 2: Optional synced workspace (reload-on-auth)

- [ ] **2.1** Make `createWhispering` accept an optional `keyring` and thread it to `createWorkspace`.
- [ ] **2.2** `whispering.synced.ts`: owner-scoped doc with `attachLocalStorage` + `openCollaboration` + `roomWsUrl`.
- [ ] **2.3** Build the `SignedIn` payload **directly from `auth.state`** with a small local `buildSignedIn(auth)` (~12 lines: server/baseURL projection, ownerId, a `keyring()` callback that re-reads `auth.state.keyring`, plus `openWebSocket` + `onReconnectSignal`). Do **NOT** use `createSession`: its whole job is the live reactive swap (`reconcile` disposes/rebuilds the payload on every auth event), which fights reload-on-auth: on a live sign-in it would eagerly construct the synced doc and open a WebSocket only for `bindAuthReload` to discard, and on sign-out it would dispose under the captured `whispering` const. Option A picks the doc once at boot, so the live machinery is exactly the part we do not want. `buildSignedIn` duplicates ~12 lines of `createSession`'s projection; that duplication is the honest cost of not using the wrong abstraction, and stays inlined until a second local-first consumer exists.
- [ ] **2.4** `openActiveWhispering()`: at boot, read `auth.state` (sync) and build the local doc (signed out) or the synced doc (signed in); export `whispering` as a stable singleton. Construction is synchronous (keyring is cached in `auth.state`); data load stays behind the existing `whenReady` gate. NO `getActiveWhispering`, NO `$lib/state` migration.
- [ ] **2.5** `bindAuthReload(auth)` in the root layout: subscribe to `auth.onStateChange` and `window.location.reload()` when the **identity key** changes. The key is `state.status === 'signed-out' ? null : state.ownerId`; capture it at boot, reload on the first change, behind a one-shot guard so the signed-out -> signed-in:owner pair on an account switch fires only one reload. **Token expiry does NOT reload**: that is `networkAccess: 'paused'` within `signed-in`, so `ownerId` (the key) is unchanged, and `openCollaboration` already reconnects internally via `onReconnectSignal` (fuji's `browser.ts` has no app-level listener for exactly this reason). So the only events that reload are deliberate sign in / sign out / switch. Recorder safety is handled at the source, not here: disable the account controls (popover + Settings) while the recorder is `RECORDING` (D3), so a reload can never interrupt an in-flight browser `MediaRecorder`. One code path for web and Tauri.
- [ ] **2.6** Wire `collaboration` into the footer `AccountPopover` so sync phase renders.

### Phase 3: Settings sync allowlist (already done, no work)

The `deviceConfig` (localStorage) vs `whispering.kv` (workspace ydoc) split already implements the allowlist (see Settings above). Secrets, selected mic, global OS shortcuts, and model paths are in `deviceConfig` and never sync; portable prefs ride the synced owner doc. Nothing to build, `settings.svelte.ts` is unchanged. Revisit only if a key is ever misfiled (e.g. a new secret added to the workspace KV by mistake): the review gate is "no secret or device-bound key in `whispering.kv`."

### Phase 4: First-sign-in migration (flag-free)

The signed-out plaintext doc is the migration SOURCE; the signed-in encrypted doc is the TARGET. They overlap ONLY here: a throwaway source reader (`openWhisperingLocal()` re-opened from the persisted plaintext IDB) alongside the active target singleton, then the source is disposed. Model the dialog/probe/copy on the existing `$lib/migration` (`probeForOldData` -> counts -> `migrateDatabaseToWorkspace`).

**State is the local data itself, not a flag.** `count = localReader.tables.recordings.size`:

```txt
count === 0  -> resolved (migrated-then-deleted, or never had data). No prompt.
count  >  0  -> prompt on EACH signed-in boot (nag; no "declined" flag)
```

Dialog, shown only when `count > 0`, three actions:

```txt
[ Add to my account ]    copy local -> owner (idempotent by id), THEN clearLocal()  -> count = 0
                         deleting the plaintext copy after encrypting it removes the need for any
                         "migrated" flag AND drops the lingering plaintext duplicate (privacy win)
[ Delete from device ]   clearLocal() only                                          -> count = 0
[ Keep for now ]         defer; count stays > 0, so the prompt returns next sign-in (the nag)
```

`clearLocal` is the existing `attachIndexedDb` primitive (`attach-indexed-db.ts:19,36`).

- [ ] **4.1** `probeLocalData()`: re-open the local doc, count rows, dispose if empty.
- [ ] **4.2** Sign-in migration dialog (sibling of `$lib/migration`): the three actions above. "Add" copies then `clearLocal()`; "Delete" `clearLocal()`; "Keep" defers. Idempotent by id (interrupted runs re-prompt and skip copied rows). **No flags**: local data presence is the only state. Per device (each device migrates its own local data into the owner doc).

Consequence to accept: after "Add", signing out shows an empty local app (data lives in the account now). That is the reconciliation option (a), made duplicate-free.

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
1. Sign-out clears auth and calls `window.location.reload()`.
2. Next startup sees signed-out auth and builds the local doc.
3. Expected: local data (whatever the local doc holds) remains; no wipe. Synced-only data is not in the local doc. See Open Questions on local/owner doc reconciliation.

### Reauth-required (token expired)
1. `auth.state` -> `reauth-required`; `createSession` keeps the payload mounted (same owner).
2. Local edits keep working; relay paused.
3. `AccountPopover` shows the failed/offline glyph + Reconnect. Expected: no data loss.

### Sign in as a different account on the same device
1. Owner changes; the reload rebuilds at startup for the new owner.
2. `attachLocalStorage` is owner-partitioned, so account B never sees account A's local owner store.
3. Expected: no cross-account contamination. The first-sign-in migration must key off the *local* doc, not a previous owner's doc.

## Open Questions

1. **Local doc vs owner doc reconciliation after sign-out.**
   - Options: (a) signed-out startup always builds the local doc, and signed-in work lives only in the owner doc (sign-out "hides" synced-only recordings until you sign back in); (b) mirror owner writes back into the local doc so signed-out keeps a read-only copy; (c) after first sign-in, treat the owner doc as the only doc on that device and never fall back.
   - **Recommendation**: (a) for MVP. Reload-on-auth implements it directly (the signed-out startup picks the local doc), it is the simplest honest model, and it matches "sync is an optional layer." Revisit if users find disappearing-on-sign-out surprising. Leave open.

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
- [ ] No secret or device-bound setting (API keys, selected mic, global OS shortcuts, model paths) can enter the synced doc: they live in `deviceConfig` (localStorage), which sign-in never touches. Portable prefs in `whispering.kv` do roam across devices, by design.
- [ ] "Upload audio" makes a recording's audio playable on another signed-in device; un-uploaded recordings clearly read as device-local.
- [ ] First sign-in migrates existing local data once with no duplication.
- [ ] `bun run --filter @epicenter/whispering check` passes; signed-out smoke test green.

## References

- `apps/whispering/src/lib/whispering/whispering.tauri.ts:46` - current local-only `openWhispering`.
- `apps/whispering/src/lib/workspace/definition.ts` - tables + ~40 KV keys to partition.
- `apps/whispering/src/lib/state/recordings.svelte.ts`, `settings.svelte.ts` - unchanged; they keep importing the `whispering` singleton (reload-on-auth means no swap to absorb).
- `apps/whispering/src/routes/(app)/_components/VerticalNav.svelte:77` - sidebar footer (popover home).
- `apps/whispering/src/routes/(app)/(config)/settings/SidebarNav.svelte` - add Account entry.
- `apps/tab-manager/src/lib/session.svelte.ts` - `createSession` + `openCollaboration` reference wiring.
- `apps/tab-manager/src/lib/platform/auth/auth.ts` - persisted-auth storage + launcher reference.
- `apps/fuji/src/lib/workspace/browser.ts` - `attachLocalStorage` + `openCollaboration` `wire()` pattern.
- `packages/svelte-utils/src/account-popover/account-popover.svelte` - drop-in sync/account UI.
- `packages/svelte-utils/src/session.svelte.ts` - `createSession` + `SignedIn` contract.
- `packages/workspace/src/document/{open-collaboration,attach-local-storage,transport}.ts` - sync primitives.
- `.claude/skills/auth/SKILL.md`, `workspace-app-composition` - composition rules (Shape A vs B).
