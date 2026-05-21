# Cloud Sync Direction Decision

**Date**: 2026-05-21
**Status**: Draft
**Author**: AI-assisted
**Branch**: codex/daemon-route-startup-cleanup

## Overview

This note pressure-tests the recent move from subject-scoped rooms to Cloud Workspace app docs. It compares the old user-room model, a pure user namespace, the current Workspace app namespace, and a heavier App Instance model.

## One Sentence

Cloud authorizes a user into a Workspace, an app opens a workspace-local Sync Doc, and Room only replicates Yjs bytes.

That sentence is the audit tool. If a design makes it need an exception, the exception must earn itself.

## What The Recent Commits Changed

The branch has moved in four related steps.

```txt
9a70f99ee
  collapse oauth resource scope
  OAuth proves API caller identity, not workspace access

302974186
  split Tab Manager local runtime from cloud sync
  local data opens without waiting for Cloud Workspace lookup
  cloud sync attaches only with a Workspace Sync Doc URL

b483d9406
  rely on personal Workspace provisioning
  /api/workspaces is read-only and does not repair missing membership

598711a2b
  rename auth state internals around PersistedAuth
  auth remains grant plus localIdentity
```

The current code now has this shape:

```txt
/api/session
  -> user
  -> localIdentity

/api/workspaces
  -> defaultWorkspaceId
  -> memberships

/workspaces/:workspaceId/apps/:appId/docs/:docId
  -> membership check
  -> v1:workspace:{workspaceId}:app:{appId}:doc:{docId}
  -> Room

/rooms/:room
  -> subject:{user.id}:rooms:{room}
  -> legacy or non-Cloud compatibility
```

## Direct Judgment

The current direction is better than the old rooms-as-product-boundary direction. Do not revert to `/rooms/:room` as the main Cloud API.

The old model was more generic, but it was generic at the wrong layer. A room is the right sync primitive and the wrong product primitive. It can replicate one named Y.Doc, but it cannot answer the product questions that Cloud must answer:

```txt
Who pays for this data?
Who can invite members?
Which shared account owns this app data?
Can a team member open this app namespace?
What route should a support, billing, export, or deletion policy start from?
```

A user-only namespace is easier to understand for solo sync, but it collapses as soon as shared Cloud data exists. It makes sharing an exception instead of a first-class path.

The current model is good if the words stay disciplined:

```txt
Auth user:
  login identity

localIdentity:
  local storage owner and keyring

Cloud Workspace:
  product account and membership boundary

App Namespace:
  workspace-local namespace for one app id

Sync Doc:
  one independently synced Y.Doc

Room:
  runtime actor for bytes
```

The risk is not that Workspace is too specific. The risk is that Workspace starts meaning too many things: auth subject, local owner, organization row, product account, app data capsule, and sync room. The answer is not to go back to rooms. The answer is to keep the layers named and owned separately.

## Direction Options

### Option A: Pure User Namespace

```txt
route:
  /users/:userId/apps/:appId/docs/:docId

internal room:
  v1:user:{userId}:app:{appId}:doc:{docId}
```

This is the shortest solo-user model. It matches the older thought: every Cloud object lives under `user:{id}` and app prefixes make collisions unlikely.

It fails when data is not personal.

```txt
Personal:
  simple

Team:
  awkward

Billing:
  user-bound by default

Sharing:
  either copy data or introduce a second owner model

Membership:
  not represented by the route
```

Verdict: reject as the Cloud product model. Keep user identity for auth and local owner identity, not shared Cloud data ownership.

### Option B: Generic Rooms As Public API

```txt
route:
  /rooms/:room

internal room:
  subject:{userId}:rooms:{room}
```

This is the most generic sync model. It is also the model from `specs/20260512T230000-generic-yjs-sync-rooms-and-checkpoints.md`: the server syncs named Y.Docs and apps decide what those docs mean.

That is still correct for the sync engine. It is not enough for Cloud product routing.

```txt
Good:
  smallest sync primitive
  portable across app meanings
  useful for local daemon or compatibility paths

Bad:
  route has no Workspace membership input
  shared data becomes encoded inside a string
  product policy must parse or trust app-built room names
  billing and deletion cannot start from a product boundary
```

Verdict: keep Room as internal sync machinery. Do not expose Room as the main Cloud product API.

### Option C: Workspace App Namespace

```txt
route:
  /workspaces/:workspaceId/apps/:appId/docs/:docId

internal room:
  v1:workspace:{workspaceId}:app:{appId}:doc:{docId}
```

This is the current direction. It makes Cloud authorization explicit without making Cloud understand app records.

```txt
Workspace:
  who can enter, invite, pay, and administer

App Namespace:
  where one app stores its root Y.Doc and optional child docs

Sync Doc:
  the thing Room replicates

Room:
  a policy-free runtime actor
```

This keeps the useful part of generic rooms while moving product checks to the edge. The route has enough information to check membership and build an opaque room name. The sync engine still sees only bytes and a room name.

Verdict: recommended phase 1 direction.

### Option D: Workspace Plus App Instance Rows

```txt
route:
  /workspaces/:workspaceId/app-instances/:appInstanceId/docs/:docId

tables:
  app_instance
  app_instance_member
  app_sync_doc
```

This model is more explicit. It is also heavier.

It earns itself only when Cloud must manage installed app lifecycle independently of app-owned Yjs data.

```txt
Earned by:
  list installed app instances from SQL
  rename an app instance
  duplicate one app instance
  delete an app namespace with relational cascade
  disable one app namespace
  meter or bill one app instance
  permission one app instance separately
```

Verdict: defer. It is the right future escape hatch, not the right phase 1 default.

## Recommendation

Keep the current Workspace App Namespace direction, but revise the product language so the design does not pretend Workspace and Organization are separate product nouns.

In phase 1:

```txt
Cloud Workspace =
  Better Auth organization presented as Workspace

Personal Workspace =
  deterministic one-member organization created at signup

Team Workspace =
  multi-member organization

App Namespace =
  workspaceId + appId

Sync Doc =
  workspaceId + appId + docId

Room =
  internal runtime for one Sync Doc
```

The personal Workspace is not a fake organization in the product sense. It is a single account container backed by the same membership table as a team Workspace. That is the Notion or Linear shape, not a Supabase projects shape.

## What To Tighten

### 1. Rename The Question

Do not ask whether data belongs to a user, organization, or workspace. Ask which boundary owns each operation.

```txt
Login:
  Better Auth user

Offline local boot:
  localIdentity subject and keyring

Cloud membership:
  Workspace member row

App data:
  app root Y.Doc

Replication:
  Room
```

This resolves most of the confusion. One raw id can appear in several layers, but the meaning changes by owner.

### 2. Keep `/rooms/:room` Out Of Cloud Client Fallbacks

The Tab Manager change is correct: missing `defaultWorkspaceId` now means no Cloud sync URL, not a fallback to a personal room.

```txt
Good:
  signed in + workspace lookup succeeds
    -> /workspaces/:workspaceId/apps/tab-manager/docs/root

Good:
  signed in + workspace lookup unavailable
    -> local-only boot

Bad:
  signed in + workspace lookup unavailable
    -> /rooms/:room
```

The bad path creates two Cloud identities for the same app data.

### 3. Keep `/api/workspaces` Read-Only

`/api/workspaces` should list memberships and fail if the personal Workspace invariant is broken. It should not create missing rows.

```txt
signup:
  creates personal Workspace
  creates owner membership

list:
  reads memberships
  asserts default exists
```

Repair-by-read hides provisioning bugs and makes account state depend on which endpoint got called first.

### 4. Do Not Put Active Workspace In Auth

Auth says who the caller is. Routes and UI say which Workspace is open.

```txt
Bad:
  ApiSessionResponse.activeWorkspaceId

Good:
  route parameter
  local UI selection
  future user preference if needed
```

Putting Workspace selection into the OAuth or session layer makes workspace switching a token or session problem. It should be navigation or product state.

### 5. Keep `localIdentity.subject` As The Migration Boundary

The exported auth type is now `LocalIdentity`, which matches the local owner
material it carries. The persisted field still says `subject`.

Possible future clean break:

```ts
type LocalIdentity = {
  ownerId: string;
  keyring: SubjectKeyring;
};
```

Do not do the field rename casually. It touches persisted auth shape and
`/api/session`. If the repo is still greenfield enough, it is worth considering
because it removes a recurring source of design confusion.

## Decision Table

| Question | Recommendation | Why |
| --- | --- | --- |
| Should Cloud sync use `/rooms/:room` as the public path? | No | Room is sync machinery, not product authorization. |
| Should everything be user-scoped? | No | It makes shared data an exception and binds billing to a person. |
| Should every user get a default Workspace? | Yes | It gives personal and team use one membership model. |
| Is that secretly a fake organization? | Internally yes, publicly no | Better Auth organization is the backing row. Product language is Workspace. |
| Should app namespace be `workspaceId + appId`? | Yes for phase 1 | It avoids an unearned `app_instance` lifecycle. |
| Should `app_instance` exist now? | No | Add it only when Cloud manages installed app lifecycle. |
| Should app docs need SQL rows before sync? | No | The app root Y.Doc owns the document graph. |
| Should `workspaces:open` come back as an OAuth scope? | No | Product access belongs in route checks. |
| Should auth expose active Workspace? | No | Workspace selection is route, UI, or preference state. |
| Should `localIdentity.subject` stay forever? | Probably no | The meaning is local owner identity, but the field is persisted and needs a migration decision. |

## Recommended Product Doc Shape

Use sub-pages, or sections that behave like sub-pages, to stop the debate from blending layers together.

```txt
Cloud Workspace Direction
  01 Current branch read
  02 Vocabulary and ownership
  03 Option A: user-only namespace
  04 Option B: public rooms
  05 Option C: workspace app namespace
  06 Option D: app instances
  07 Decision matrix
  08 Implementation invariants
  09 Open questions
```

Each page should answer one question only. Do not mix naming, billing, auth, local-first boot, and Yjs room mechanics on the same page.

## Review Prompts

Use these prompts to get a better answer from future agent passes.

### Prompt 1: Attack The Current Direction

```txt
Review `specs/20260521T120000-cloud-sync-direction-decision.md` and attack Option C. Find the first product requirement that would make Workspace App Namespace insufficient. Do not propose compatibility paths. Output concrete failure cases, the first table or route they would earn, and whether the failure exists in phase 1.
```

### Prompt 2: Defend User-Only Sync

```txt
Assume Epicenter Cloud never ships shared Workspaces. Review whether a pure user namespace would simplify auth, storage, sync, billing, and local-first boot. Then list the exact first feature that would force abandoning it.
```

### Prompt 3: Draw The Boundary

```txt
For each value in the current implementation, assign exactly one owner: auth user id, localIdentity.subject, workspaceId, appId, docId, Y.Doc.guid, IndexedDB docName, BroadcastChannel name, roomName, asset key, billing customer id. Flag every value that is currently overloaded.
```

### Prompt 4: Earn App Instance

```txt
Write the smallest product story that earns an `app_instance` table. It must include a user-visible operation, route shape, table shape, and migration from `workspaceId + appId`. If no phase 1 story earns it, say so.
```

## Open Questions

1. Is the product willing to say every account is a Workspace, including personal accounts?
2. Should `localIdentity.subject` become `localIdentity.ownerId` before the persisted auth shape hardens?
3. Should the first-party app catalog live in constants, API, or each app package?
4. What is the first product operation that needs `app_instance`?
5. What is the first product operation that needs `app_sync_doc`?
6. Does Cloud need any user-only sync after Tab Manager, Fuji, Honeycrisp, and Opensidian migrate?

## Naming Audit Update

Date: 2026-05-21

The greenfield audit keeps the one-sentence model:

```txt
Cloud authorizes an auth user into a Cloud Workspace.
An app opens a workspace-local Sync Doc.
Room only replicates Yjs bytes.
```

Final naming model:

```txt
Auth user:
  login identity
  Better Auth user
  OAuth subject at the bearer boundary

LocalIdentity:
  cached local owner label and keyring
  persisted as localIdentity.subject for now
  translated to LocalOwner.ownerId before workspace storage opens

Cloud Workspace:
  product account and membership boundary
  Better Auth organization presented as Workspace

Better Auth organization:
  backing row for Cloud Workspace
  not a public Cloud product noun

App:
  app definition or package

App Namespace:
  workspaceId + appId
  no SQL row in phase 1

Sync Doc:
  workspaceId + appId + docId
  independently synced Y.Doc
  resolver surface should say Sync Doc, not generic App Doc

Room:
  internal Yjs replication actor
  receives an opaque roomName after route authorization
```

Naming decisions:

| Current surface | Decision | Rationale |
| --- | --- | --- |
| `SubjectIdentity` exported auth type | Rename to `LocalIdentity` | The type means local owner material, not Cloud product subject. The persisted field shape remains unchanged. |
| `localIdentity.subject` field | Defer | It is persisted auth and `/api/session` shape. Rename only with an explicit migration or reset rule. |
| `workspaceAppDoc` API resolver names | Rename internal resolver to `workspaceSyncDoc` | The product object being authorized is a Sync Doc. `appId` remains one segment of that identity. |
| `resourceName` in the resolver | Rename resolver field to `syncDocResourceName` | The route target is a Sync Doc identity. The durable DB column stays `resource_name` until a telemetry migration earns itself. |
| `/rooms/:room` | Keep only as compatibility sync machinery | It is not a Cloud Workspace product route and must not be a Cloud client fallback. |
| Cloud route helpers in `@epicenter/workspace` | Defer code move | `@epicenter/workspace` is published. Moving route helpers is a package API break, even though the owner is wrong. |
| `defaultWorkspaceId` | Keep for now | It means the bootstrap personal Cloud Workspace. It must not become active Workspace state in auth/session. |

Deferred triggers:

```txt
localIdentity.subject -> localIdentity.ownerId:
  revisit on the first persisted auth migration, `/api/session` reset rule,
  or code path that builds Cloud product state from localIdentity.subject

Cloud helpers leaving @epicenter/workspace:
  revisit before the next published @epicenter/workspace release that would
  freeze these exports, or when a second app needs the same Cloud bootstrap

durable_object_instance.resource_name:
  revisit when billing, dashboard, admin, retention, or support reads it as
  product data

app_instance:
  revisit when Cloud must list, rename, delete, duplicate, disable, bill, or
  permission an installed app separately from Workspace membership

app_sync_doc:
  revisit when Cloud must delete, migrate, inspect, meter, retain, legally hold,
  or search Sync Docs without reading the app root Y.Doc

workspace_profile:
  revisit when Workspace owns product fields that should not live in Better Auth
  organization metadata

activeWorkspaceId:
  revisit only when UI has a real Workspace selector; keep it in route, UI, or
  preference state, not OAuth or auth/session
```

## Bottom Line

The old room model was more generic, but generic in the way a string key is generic. It hid the product boundary.

The current Workspace App Namespace model is the better Cloud direction. It gives Cloud the authorization inputs it needs and keeps Room generic where generic actually helps. The design stays good only if local owner identity, Workspace membership, app namespace, Sync Doc, and Room remain separate concepts.
