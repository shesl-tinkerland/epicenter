# Subject And Owner Boundary

**Date**: 2026-05-15
**Status**: Implemented
**Author**: AI-assisted

## One Sentence

Epicenter calls the server-issued keyed identity `subject` at auth and crypto boundaries, then calls the same value `ownerId` once it enters browser-local workspace storage.

## Overview

This spec records the naming boundary introduced during the auth canonical path cleanup. The value currently comes from Better Auth `user.id`, but the client treats it as a server-issued identity label. Auth uses that label to derive key material. Workspace storage uses that label to isolate local IndexedDB databases, BroadcastChannel names, and wipe prefixes.

## Current Shape

```txt
/api/me
  -> localIdentity.subject
  -> SubjectKeyring
  -> createSession
  -> createLocalOwner({ ownerId: localIdentity.subject, keyring })
  -> epicenter.owner.{ownerId}.yjs.{ydocGuid}
```

The value is the same string across the handoff. The name changes because the responsibility changes.

```ts
createLocalOwner({
	ownerId: auth.state.localIdentity.subject,
	keyring: () => auth.state.localIdentity.keyring,
});
```

## Motivation

### Current State

The auth cleanup moved from user vocabulary to subject vocabulary:

```txt
deriveSubjectKeyring(subject)
SubjectKeyring
localIdentity.subject
```

That was correct for the server and key hierarchy. The trouble was that the same word leaked into local storage:

```txt
createLocalOwner({ subject, keyring })
epicenter.subject.{subject}.yjs.{guid}
```

This made local persistence sound like JWT theory. It also hid the more useful workspace idea: this local data belongs to an owner.

### Desired State

Keep subject vocabulary where it explains auth. Use owner vocabulary where it explains local persistence.

```txt
subject
  auth identity label
  used by /api/me, key derivation, DO subject names, auth state

ownerId
  local workspace owner label
  used by createLocalOwner, createOwnedYjsKey, IndexedDB, BroadcastChannel, wipe
```

## Design Decisions

| Decision | Class | Choice | Rationale |
| --- | --- | --- | --- |
| Auth field name | 2 coherence | Keep `localIdentity.subject` | The API issues a server-stamped identity label. It may later be scoped as `issuer:userId` or `tenant:userId` without changing the client shape. |
| Keyring vocabulary | 2 coherence | Keep `SubjectKeyring` and `deriveSubjectKeyring` | The root keyring derives material for an authenticated subject. `OwnerKeyring` would make crypto sound like storage ownership. |
| Workspace owner API | 2 coherence | Use `createLocalOwner({ ownerId, keyring })` | The workspace package is naming local browser data, not auth claims. |
| Durable browser prefix | 2 coherence | Use `epicenter.owner.{ownerId}.yjs.{ydocGuid}` | The prefix protects local persistence ownership. It should not expose the auth term unless that term is the clearer local concept. |
| DO names | 2 coherence | Keep `subject:{subject}:rooms:{room}` | Durable Objects are server-routed by authenticated subject. This remains an auth boundary, not a browser-local storage boundary. |
| Organization id as subject | Deferred | Do not use plain `orgId` | `subject = orgId` would make every org member share one subject keyring. That is a product and security decision, not a naming cleanup. |

## Architecture

```txt
SERVER / AUTH
────────────────────────────────────────
Better Auth user.id today
  -> API chooses subject
  -> deriveSubjectKeyring(subject)
  -> /api/me localIdentity.subject

CLIENT / SESSION HANDOFF
────────────────────────────────────────
localIdentity.subject
  -> createLocalOwner({ ownerId: subject, keyring })

WORKSPACE / LOCAL STORAGE
────────────────────────────────────────
ownerId
  -> createOwnedYjsKey(ownerId, ydoc.guid)
  -> IndexedDB database name
  -> BroadcastChannel name
  -> wipeLocalYjsData prefix
```

## Grill Questions

### Is `subject` genuinely better than `userId`?

Recommended answer: yes at the auth boundary. `userId` is true today, but it commits the persisted client shape to Better Auth's user table. `subject` says the server chooses the keyed identity label.

### Is `subject` genuinely better than `ownerId`?

Recommended answer: no, not everywhere. `subject` is better for auth and crypto. `ownerId` is better for local workspace storage. Using both is not indecision; it marks the layer change.

### Could `subject` become an organization id?

Recommended answer: not as a casual rename. If `subject = orgId`, all members would derive the same subject keyring unless the server adds another key axis. The safer future shape is usually `tenantId:userId`, not plain `orgId`.

### Why not use `principal`?

Recommended answer: `principal` is technically valid but worse for this codebase. It is security jargon, and it does not clarify the local storage role. `subject` is already familiar from OAuth `sub`.

### Why not use `identityId`?

Recommended answer: it is less wrong than `userId`, but too vague. It does not say whether the value is for auth, local ownership, profile lookup, or presence.

### Why not call everything `ownerId`?

Recommended answer: key derivation would get fuzzier. The server derives key material for the authenticated subject. Local data belongs to an owner. Those are related but not identical responsibilities.

### Where should the translation happen?

Recommended answer: at `createSession`. That is where auth state becomes a workspace owner. It is also the narrowest handoff:

```txt
ownerId: state.localIdentity.subject
```

## Implementation Notes

- `packages/auth/src/auth-types.ts` documents `subject` as the server-issued identity label.
- `packages/svelte-utils/src/session.svelte.ts` translates `localIdentity.subject` into `ownerId`.
- `packages/workspace/src/document/local-owner.ts` accepts `ownerId`.
- `packages/workspace/src/document/local-yjs-key.ts` emits the `epicenter.owner.` prefix.
- `apps/api/src/app.ts` keeps DO route naming in `subject:` vocabulary and documents why browser storage uses `ownerId`.

## Validation

- [x] `createLocalOwner` uses `ownerId`, not `subject`.
- [x] `createOwnedYjsKey` uses `ownerId`, not `subject`.
- [x] Local IndexedDB and BroadcastChannel tests pin `epicenter.owner.`
- [x] Auth and API code keep `subject` at server and keyring boundaries.
- [x] Run focused workspace and auth tests after any follow-up edits.

## Future Reconsideration

Reopen this decision if one of these becomes true:

1. A real organization-scoped decrypt model ships.
2. A service-account or machine identity needs local workspace storage.
3. Sharing makes one local browser profile open multiple owners inside one mounted app session.
4. A migration must preserve already-shipped `epicenter.subject.` databases.

Until then, the rule is simple:

```txt
Use subject for auth identity.
Use ownerId for browser-local workspace ownership.
Translate once at the session boundary.
```

## Review

**Completed**: 2026-05-15
**Branch**: `codex/auth-spec-audit-followup`

### Summary

The subject versus owner boundary is implemented as written. Auth and API code
keep `subject` at server, keyring, and Durable Object boundaries; Svelte session
creation translates `localIdentity.subject` to `ownerId`; workspace local
persistence and BroadcastChannel names use the `epicenter.owner.` prefix.

### Verification

- `bun test packages/workspace/src/document/local-yjs-key.test.ts packages/workspace/src/document/local-owner.test.ts`: 10 pass.
- `bun test packages/auth/src/contract.test.ts apps/api/src/api-me.test.ts apps/api/src/auth/resource-boundary.test.ts`: 33 pass.
- `bun run --cwd packages/workspace typecheck`: pass.
- `bun run --cwd packages/auth typecheck`: pass.
- `bun run --cwd packages/svelte-utils typecheck`: pass, 0 errors and 0 warnings.
- `bun run --cwd apps/api typecheck`: pass.

### Deviations from Spec

- None.

### Follow-up Work

- None for this boundary. Reopen only for the future reconsideration cases
  above.
