# Session Owned Subject Owner Boundary

**Date**: 2026-05-16
**Status**: Draft
**Author**: AI-assisted

## One Sentence

`createSession` converts an auth subject with a keyring into a local workspace owner that can open encrypted browser storage.

## Overview

Epicenter should keep `subject` as the auth, API, server routing, and crypto word, and keep `ownerId` as the browser-local workspace storage word. The boundary should change exactly once: inside `createSession`, where an identity-bearing auth state becomes a mounted local workspace session.

This spec does not propose a rename yet. It records the invariant to grill before any cleanup: ordinary browser app code should not have to decide whether a value is a `subject`, `ownerId`, or `userId`.

## Motivation

### Current State

The current live flow is:

```txt
OAuth access token sub
  -> Better Auth user.id
  -> /api/me localIdentity.subject
  -> PersistedAuth.localIdentity.subject
  -> auth.state.localIdentity.subject
  -> createSession()
  -> createLocalOwner({ ownerId: subject, keyring })
  -> epicenter.owner.{ownerId}.yjs.{ydocGuid}
```

The actual rename is in `packages/svelte-utils/src/session.svelte.ts`:

```ts
owner: createLocalOwner({
	ownerId: state.localIdentity.subject,
	keyring: () => {
		if (auth.state.status === 'signed-out') {
			throw new Error('[session] keyring() called while signed-out.');
		}
		return auth.state.localIdentity.keyring;
	},
});
```

That line is doing real conceptual work. Before it, the value is a server-issued subject that chooses key material. After it, the same string names local IndexedDB databases, BroadcastChannel channels, and wipe prefixes.

This creates problems where examples or app code bypass the session boundary:

1. **Manual translation leaks outward**: Examples that ask app authors to pass `subject`, `ownerId`, or `userId` make callers learn the internal boundary.
2. **Old names keep coming back**: Some docs still teach `userId`, old attach APIs, or old auth helpers. Those are not alternate valid names; they are stragglers.
3. **The workspace API can sound more auth-shaped than it is**: `createLocalOwner` is a local storage boundary. It should not ask for `subject`.

### Desired State

The rule should be boring:

```txt
Auth exposes subject.
Session translates subject to owner.
Workspace consumes owner.
```

The ideal browser app call site should usually look like this:

```ts
export const session = createSession({
	auth,
	build: ({ owner }) => openApp({ owner, openWebSocket: auth.openWebSocket }),
});
```

Lower-level workspace examples may still show `ownerId`, but ordinary app session wiring should not make each app repeat the subject to owner translation.

## Boundary Options

| Option | Rename point | Result | Verdict |
| --- | --- | --- | --- |
| API boundary | `/api/me` returns `ownerId` | Auth response hides that this value is the OAuth subject and key derivation label | Reject |
| Auth state boundary | `auth.state.localIdentity.ownerId` | Auth state names local storage before a workspace exists | Reject |
| Session boundary | `createSession` maps `localIdentity.subject` to `ownerId` | The concept changes when auth state becomes a local workspace session | Choose |
| Workspace internals | `createLocalOwner({ subject })` maps internally | Workspace local persistence speaks auth vocabulary | Reject |

## Design Decisions

| Decision | Class | Choice | Rationale |
| --- | --- | --- | --- |
| Canonical auth name | 2 coherence | `subject` | The value comes from OAuth `sub` through Better Auth `user.id`, drives `/api/me`, and derives `SubjectKeyring`. |
| Canonical local storage name | 2 coherence | `ownerId` | The value names browser-local ownership: IndexedDB, BroadcastChannel, and wipe scope. |
| Translation owner | 2 coherence | `createSession` | This is where auth state first becomes a mounted browser workspace. |
| Public workspace owner surface | 2 coherence | `LocalOwner` | Passing an owner object hides storage naming from ordinary app builders. |
| Durable IndexedDB prefix | 1 evidence | Keep `epicenter.owner.{ownerId}.yjs.{guid}` | Tests pin this shape in `packages/workspace/src/document/local-yjs-key.test.ts`. |
| HKDF info string | 1 evidence | Keep `subject:{subject}` | Changing this changes key derivation semantics and can orphan encrypted data. |
| DO room name | 1 evidence | Keep `subject:{subject}:rooms:{room}` | Changing this changes server routing and durable object names. |
| Organization subject | Deferred | No plain `orgId` subject | `subject = orgId` would make org members share subject key material unless a new key axis exists. |

## Architecture

```txt
SERVER AND AUTH
────────────────────────────────────────
OAuth sub
  -> Better Auth user.id
  -> API chooses subject
  -> deriveSubjectKeyring(subject)
  -> /api/me localIdentity.subject
  -> auth.state.localIdentity.subject

SESSION BOUNDARY
────────────────────────────────────────
createSession(auth)
  -> createLocalOwner({
       ownerId: auth.state.localIdentity.subject,
       keyring: () => auth.state.localIdentity.keyring
     })

WORKSPACE LOCAL STORAGE
────────────────────────────────────────
LocalOwner
  -> attachIndexedDb(ydoc)
  -> createOwnedYjsKey(ownerId, ydoc.guid)
  -> epicenter.owner.{ownerId}.yjs.{ydocGuid}

LocalOwner
  -> attachBroadcastChannel(ydoc)
  -> createOwnedYjsKey(ownerId, ydoc.guid)

LocalOwner
  -> wipeLocalYjsData()
  -> getOwnedYjsPrefix(ownerId)
```

## Invariants To Grill

### Invariant 1: Auth never exposes `ownerId`

Auth may expose `subject`, `localIdentity`, and `SubjectIdentity`. It should not expose `ownerId`, because auth has no local storage owner until a workspace session is built.

Grill question:

```txt
Would `ownerId` still be honest if the caller never opens a browser workspace?
```

Recommended answer:

```txt
No. That is why auth should keep `subject`.
```

### Invariant 2: Workspace local persistence never asks for `subject`

Workspace may mention subject in crypto comments and peer presence. The local owner API should ask for `ownerId`, because its job is to own local data.

Grill question:

```txt
Would `subject` still be honest inside a function that only builds an IndexedDB key?
```

Recommended answer:

```txt
No. That is why `createOwnedYjsKey(ownerId, guid)` is the right shape.
```

### Invariant 3: Ordinary browser app code should receive `LocalOwner`

App workspace factories should prefer `owner: LocalOwner` over `ownerId: string` when the app is opened from `createSession`. The low-level package can keep `ownerId` for tests, examples, and custom runtimes.

Grill question:

```txt
Does the app need to know how local storage keys are named?
```

Recommended answer:

```txt
Usually no. It needs an owner capability that can attach storage and wipe local data.
```

### Invariant 4: Durable labels are not cleanup targets

`subject:{subject}` in HKDF, `subject:{subject}:rooms:{room}` in DO names, and `epicenter.owner.{ownerId}.yjs.{guid}` in IndexedDB are compatibility boundaries. Renaming them needs a migration plan and product decision.

Grill question:

```txt
Can this cleanup change stored data names or key derivation info strings?
```

Recommended answer:

```txt
No. That would be a migration, not a naming cleanup.
```

## Straggler Hunt Scope

After the invariants are confirmed, hunt for stragglers in these categories:

| Straggler | Search shape | Expected fix |
| --- | --- | --- |
| Old auth user naming in local storage docs | `userId`, `wipeOwnerLocalYjsData`, `attachOwnedBroadcastChannel` | Update docs to `LocalOwner`, `ownerId`, and current APIs. |
| Manual subject to owner translation outside session | `ownerId: auth.state.localIdentity.subject` | Prefer passing `LocalOwner` from `createSession` when practical. |
| App workspace factory takes `ownerId` but is only called from session | `open*({ ownerId` | Consider taking `owner: LocalOwner` instead. |
| Workspace local APIs that accept `subject` | `createLocalOwner({ subject`, `createOwnedYjsKey(subject` | Rename to `ownerId` unless the function is auth or crypto owned. |
| Auth APIs that expose `ownerId` | `localIdentity.ownerId`, `AuthState.*ownerId` | Reject or move translation to session. |
| Durable key changes disguised as cleanup | `subject:`, `epicenter.owner.` | Pause for migration and product decision. |

Suggested commands:

```sh
rg -n "localIdentity\\.subject|ownerId|userId|SubjectIdentity|createLocalOwner|createOwnedYjsKey|wipeOwnerLocalYjsData|attachOwnedBroadcastChannel" apps packages docs specs --glob '!**/LICENSE'
rg -n "epicenter\\.subject|epicenter\\.owner|subject:\\{subject\\}|subject:\\$\\{|rooms:" apps packages docs specs --glob '!**/LICENSE'
```

## Implementation Plan

### Phase 1: Grill The Boundary

- [x] **1.1** Read this spec and `specs/20260515T172411-subject-owner-boundary.md`.
- [x] **1.2** Reconstruct the live data flow from `/api/me` to `createOwnedYjsKey`.
- [x] **1.3** Test each invariant against real callers.
- [x] **1.4** Decide whether `createSession` is truly the only ordinary browser app translation boundary.
- [x] **1.5** Record any counterexample that would make the boundary move.

### Phase 2: Hunt Stragglers

- [x] **2.1** Run the straggler searches above.
- [x] **2.2** Classify every match as current contract, stale doc, stale example, low-level API, durable compatibility boundary, or unrelated use.
- [x] **2.3** Produce a table of stragglers with recommended action.
- [x] **2.4** Pause before editing if a proposed action changes persisted auth, IndexedDB, DO names, or HKDF labels.

### Phase 3: Optional Cleanup

- [x] **3.1** Update stale docs and examples after the boundary decision is confirmed.
- [x] **3.2** Prefer `LocalOwner` in app workspace factories that are only opened from `createSession`.
- [x] **3.3** Run focused doc checks for touched packages.
- [x] **3.4** Add a review section to this spec with evidence and remaining risks.

## Open Questions

1. Should `createSession` be the only public browser session helper, or should apps still be allowed to construct `createLocalOwner` directly?
2. Should app workspace factories accept `owner: LocalOwner` by convention, or only when they are browser-only?
3. Should docs split examples into two lanes: low-level workspace package usage with `ownerId`, and app session usage with `LocalOwner`?
4. Should `SubjectIdentity.subject` be branded to prevent accidental assignment into unrelated string fields, or is that too much type ceremony?

## Goal Prompt

```txt
/goal Grill `specs/20260516T120000-session-owned-subject-owner-boundary.md` until the subject to owner boundary is either proven correct at `createSession` or replaced by a clearer boundary with explicit invariants. First read that spec, `specs/20260515T172411-subject-owner-boundary.md`, `packages/auth/src/auth-types.ts`, `packages/auth/src/create-oauth-app-auth.ts`, `packages/svelte-utils/src/session.svelte.ts`, `packages/workspace/src/document/local-owner.ts`, `packages/workspace/src/document/local-yjs-key.ts`, `apps/api/src/auth/resource-boundary.ts`, and `apps/api/src/app.ts`. Work in checkpoints: reconstruct live flow, challenge each invariant, search for counterexamples with `rg`, classify stragglers, and recommend whether to keep the boundary, move it, or clean docs and examples only. Surface evidence with file references, grep results, and a final table of straggler -> layer -> classification -> action. Do not rename anything unless explicitly asked after the grill. Pause if any proposed change touches persisted auth shape, IndexedDB or BroadcastChannel keys, Durable Object names, API response shape, or HKDF key derivation labels.
```

## Review

Completed: 2026-05-16

Decision: keep the subject to owner boundary at `createSession`.

The grill found no better boundary. Auth and API code still own `subject`, workspace local persistence owns `ownerId`, and ordinary browser app factories should receive `LocalOwner` from `createSession`.

Evidence:

- `apps/api/src/auth/resource-boundary.ts` returns `/api/me` as `localIdentity.subject` plus a per-subject keyring.
- `packages/auth/src/auth-types.ts` keeps `SubjectIdentity` and `PersistedAuth.localIdentity` in auth vocabulary.
- `packages/auth/src/create-oauth-app-auth.ts` wipes the persisted cell when `/api/me` returns a different subject.
- `packages/svelte-utils/src/session.svelte.ts` performs the only ordinary browser app translation: `ownerId: state.localIdentity.subject`.
- `packages/workspace/src/document/local-owner.ts` and `packages/workspace/src/document/local-yjs-key.ts` consume `ownerId` and preserve the `epicenter.owner.` local storage prefix.
- `apps/api/src/app.ts` keeps Durable Object names in subject vocabulary with `subject:{subject}:rooms:{room}`.

Cleanup completed:

- Updated `docs/guides/consuming-epicenter-api.md` to use `createSession`, `LocalOwner`, `owner.attachIndexedDb`, `owner.attachBroadcastChannel`, and `owner.wipeLocalYjsData`.
- Updated `docs/encryption.md` to describe the current `LocalOwner` handoff and auth same-subject guard.
- Updated `packages/workspace/README.md` and `packages/workspace/src/document/README.md` to remove stale `attachOwnedBroadcastChannel`, `wipeOwnerLocalYjsData`, and `userId` examples.
- Updated `apps/fuji/README.md` to match the live `openFujiBrowser({ owner, replicaId, openWebSocket })` shape.

Focused checks:

```sh
rg -n "attachOwnedBroadcastChannel|wipeOwnerLocalYjsData|\\buserId\\b|build:\\s*\\(identity\\)|createCookieAuth|EncryptionKeys|requireSignedIn|bearerToken|identity switch reloads|different-user transition.*reloads|identity:" docs/guides/consuming-epicenter-api.md docs/encryption.md packages/workspace/README.md packages/workspace/src/document/README.md apps/fuji/README.md
rg -n "ownerId:\\s*auth\\.state\\.localIdentity\\.subject|createLocalOwner\\(\\{\\s*subject|createOwnedYjsKey\\(\\s*subject|getOwnedYjsPrefix\\(\\s*subject|localIdentity\\.ownerId|AuthState.*ownerId|PersistedAuth.*ownerId|SubjectIdentity.*ownerId" apps packages docs --glob '!**/LICENSE'
rg -n $'\\u2014|\\u2013' docs/guides/consuming-epicenter-api.md docs/encryption.md packages/workspace/README.md packages/workspace/src/document/README.md apps/fuji/README.md
```

All focused checks returned no matches after cleanup.

No runtime boundary changed. No persisted auth shape, API response shape, IndexedDB or BroadcastChannel key, Durable Object name, or HKDF label changed.
