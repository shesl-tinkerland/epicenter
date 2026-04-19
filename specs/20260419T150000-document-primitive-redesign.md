# Document Primitive Redesign: `defineDocument` as the Lower-Level Substrate

**Date**: 2026-04-19
**Status**: Draft
**Author**: AI-assisted (Braden + Claude)

## Overview

Introduce a lower-level primitive — `defineDocument` — that owns Y.Doc lifecycle and nothing else. `createWorkspace` and its `.withExtension` builder chain stay exactly as they are today at the call site; internally, they become sugar built on top of `defineDocument`. `.withDocument()` (the per-row subdoc declaration attached to a table) is **removed entirely** — per-row content docs become child `defineDocument`s, opened by a small helper, with their closures free to reference the parent workspace's tables.

Two layers, one primitive, zero hooks object:

```
┌────────────────────────────────────────────────────────────┐
│  packages/workspace — createWorkspace + .withExtension(*)  │  ← unchanged surface
│  Sugar layer for the 90% single-doc app case.              │
├────────────────────────────────────────────────────────────┤
│  packages/yjs-doc — defineDocument + openDocument          │  ← new package
│  Async bootstrap closure. Cleanup via ydoc.on('destroy').  │
│  No hooks object, no registry, no providers array.         │
└────────────────────────────────────────────────────────────┘
```

## Motivation

### The `.withDocument` XML smell

`.withDocument` was the *originating* complaint. Look at the real call site:

```ts
// apps/fuji/src/lib/workspace.ts:107-112
export const fuji = defineWorkspace({ id: 'epicenter.fuji', tables: { entries } })
  .withDocument('content', {
    content: richText,                                // 2nd "content"
    guid: 'id',
    onUpdate: () => ({ updatedAt: DateTimeString.now() }),
  })
```

Three things are wrong here, and they compound:

1. **Three unrelated uses of `"content"`** — the registration name, the field key in the config, and (hidden) `ydoc.getText('content')` inside `richText`'s strategy at `packages/workspace/src/workspace/strategies.ts:47`. Convention masquerading as configuration.
2. **`onUpdate` lives in doc config but mutates the row**. Inversion of control done backwards: the child doc shouldn't know that its updates ripple into a row on the parent.
3. **Nested declarative block inside the workspace builder** — the per-row doc is defined *inside a table, inside a workspace*, as an object literal, with its lifecycle implicitly tied to the enclosing `createWorkspace`. That shape is fine for XML. It's wrong for composable Yjs documents.

### The single-Y.Doc ceiling (real, not hypothetical)

`createWorkspace` allocates exactly one Y.Doc (`create-workspace.ts:131`). Real apps already work around this:

| App | Evidence |
|---|---|
| Opensidian | `apps/opensidian/src/lib/client.ts:203` — calls `createWorkspace` twice (opensidian + skills), duplicating extension wiring, because there is no shared-doc primitive. |
| Whispering | `apps/whispering/…/kv.ts:188` — comment explicitly says API keys/paths/hardware IDs stay in localStorage "because only preferences that roam live here." Translation: we want a separate settings doc but the API gives us one. |
| Filesystem | `packages/filesystem/src/table.ts:21-24` — markdown, sheets, and canvas data all flattened through a single `timeline` strategy. One doc per app means one content type per file. |

### The `.withExtension` × 3 variants foot-gun

Today there are three parallel methods (`create-workspace.ts:470-549`):

```ts
.withExtension(key, factory)            // workspace AND every doc
.withWorkspaceExtension(key, factory)   // workspace only
.withDocumentExtension(key, factory)    // docs only — literally unused in the repo
```

Users must read JSDoc to know which scope each covers. `.withDocumentExtension` is dead public API. This complexity exists only to thread extensions into `.withDocument`'s subdocs — which this redesign eliminates.

### Standalone external consumers

Yjs apps outside epicenter don't want `tables`, `kv`, or `awareness`. They want "I have a Y.Doc, compose providers against it with typed API and clean disposal." No such package exists in the ecosystem — SyncedStore is the closest public shape (a factory that takes a Y.Doc and returns a typed proxy), but it owns the data schema. `packages/yjs-doc` fills that gap.

## The Primitive

### Shape

```ts
// packages/yjs-doc

export function defineDocument<T>(
  id: string,
  bootstrap: (ydoc: Y.Doc) => Promise<T>,
): DocumentDefinition<T>

export function openDocument<T>(
  def: DocumentDefinition<T>,
): Promise<T & { ydoc: Y.Doc; dispose: () => Promise<void> }>
```

That's the entire primitive. No hooks object. No providers array. No lifecycle registry.

### Why no hooks?

An earlier draft of this spec had `hooks: { onReady, onDispose, onUpdate }` passed as a second argument to the bootstrap. During review we realized every hook was wrapping something Y.Doc already does:

| Hook | Real job | Native Y.Doc equivalent |
|---|---|---|
| `onDispose(fn)` | Register cleanup | `ydoc.on('destroy', fn)` — native event |
| `onReady(fn)` | Async init ordering | `await` inside an async bootstrap |
| `onUpdate(fn)` | Listen to updates, auto-cleanup | `ydoc.on('update', fn)` + register `ydoc.on('destroy', () => ydoc.off('update', fn))` (one line) |

Hooks were reinventing `ydoc.on('destroy')` because the earlier draft didn't trust Y.Doc's event system. Removing the wrapper removes a concept, removes a type, removes indirection, and makes the ordering visible in plain code:

```ts
// With hooks (rejected):
hooks.onReady(() => idb.whenSynced)      // "sync waits on idb" is implicit in registration order
hooks.onReady(() => connectSync())       // easy to get wrong, invisible at call site

// Without hooks (chosen):
const idb = attachIndexedDb(ydoc)
await idb.whenSynced                     // ordering is literally the code
const sync = attachSync(ydoc, { url, getToken })
```

The linear async function is the ordering. `await` is the ready signal. `ydoc.on('destroy')` is the cleanup registrar. Everything a hooks object did, the language already provides.

### Internals of `openDocument` (~20 lines)

```ts
export function defineDocument<T>(id: string, bootstrap: (ydoc: Y.Doc) => Promise<T>) {
  return { id, bootstrap }
}

export async function openDocument<T>(def: { id: string; bootstrap: (ydoc: Y.Doc) => Promise<T> }) {
  const ydoc = new Y.Doc({ guid: def.id, gc: false })
  const api = await def.bootstrap(ydoc)
  const dispose = async () => {
    ydoc.destroy()              // fires 'destroy' → every attach helper's cleanup runs
  }
  return { ...api, ydoc, dispose }
}
```

Attach helpers self-register their cleanup on the `'destroy'` event:

```ts
export function attachIndexedDb(ydoc: Y.Doc) {
  const idb = new IndexeddbPersistence(ydoc.guid, ydoc)
  ydoc.on('destroy', () => idb.destroy())
  return {
    whenSynced: idb.whenSynced,
    clearLocal: () => idb.clearData(),
  }
}

export function attachSync(ydoc: Y.Doc, opts: { url: string; getToken: () => Promise<string> }) {
  const provider = new WebsocketProvider(opts.url, ydoc.guid, ydoc, {
    params: { token: await opts.getToken() },
  })
  ydoc.on('destroy', () => provider.destroy())
  return {
    reconnect: () => provider.connect(),
    disconnect: () => provider.disconnect(),
  }
}
```

Y.Doc's `'destroy'` event fires LIFO naturally in V8 (listener list, pushed in registration order, iterated in insertion order — but `attachIndexedDb` runs before `attachSync` so sync destroys first if registered last). If strict LIFO becomes important later, `openDocument` can maintain its own destroy list. For now, registration-order destruction is sufficient.

## Call Sites

### Single-doc app — `createWorkspace` is UNCHANGED

This is the 90% case. If your app fits in one Y.Doc, nothing about your call site changes:

```ts
// apps/fuji/src/lib/workspace.ts — SAME AS TODAY (no .withDocument though)
export const fuji = defineWorkspace({ id: 'epicenter.fuji', tables: { entries } })

// apps/fuji/src/lib/client.ts — SAME AS TODAY
export const workspace = createWorkspace(fuji)
  .withExtension('persistence', indexeddbPersistence)
  .withExtension('sync', createSyncExtension({ url, getToken: () => auth.token }))
  .withActions((client) => ({
    createEntry: defineMutation({ ... }),
  }))
```

Progressive extension typing preserved. Actions work exactly the same. The only thing missing from today's call site is `.withDocument('content', { content: richText, ... })` — and that's deliberate. Per-row content docs are now handled below.

### Per-row content doc — replacing `.withDocument`

This is the change you feel at the call site. `.withDocument` is gone. The per-entry rich-text document is a first-class `defineDocument`, opened lazily per row, with a closure that references the parent workspace's table.

```ts
// apps/fuji/src/lib/content-doc.ts — new file
import { defineDocument, attachRichText, attachIndexedDb, attachSync } from '@epicenter/yjs-doc'
import { workspace } from './client'

export function entryContentDoc(row: { id: string }) {
  return defineDocument(`epicenter.fuji.entries.${row.id}.content`, async (ydoc) => {
    const content = attachRichText(ydoc)

    const idb = attachIndexedDb(ydoc)
    await idb.whenSynced

    const sync = attachSync(ydoc, { url, getToken: () => auth.token })

    // Closure references the parent workspace's table — this is the IoC win
    ydoc.on('update', () => {
      workspace.tables.entries.update(row.id, { updatedAt: DateTimeString.now() })
    })

    return { content, idb, sync }
  })
}

// Opening one per-row content doc:
const { content } = await openDocument(entryContentDoc(row))
content.write('hello world')
// Later:
await disposeDoc()
```

Three wins over `.withDocument`:

1. **One naming of `"content"`**, where it's actually a variable name, not a registration key.
2. **The row-touch `onUpdate` is a plain closure** — it references `workspace.tables.entries` directly, no "return a partial row object" convention.
3. **Per-row doc extensions are regular attach calls** — the child doc has its own idb, its own sync, its own awareness if it wants. Not inherited implicitly from the workspace.

For apps that open many of these (fuji's editor, honeycrisp's cards), a thin `attachChildDocs(parentTable, rowFactory)` helper handles the row→doc lifecycle (open on create, close on delete, cache by id). That helper lives in `packages/workspace`, built on top of `openDocument`. It's a userland helper, not part of the primitive.

```ts
// apps/fuji/src/lib/workspace.ts
const entryContentDocs = attachChildDocs(workspace.tables.entries, entryContentDoc)
// entryContentDocs.get(row.id) — returns the open doc or opens it lazily
// entryContentDocs.close(row.id) — explicit close
```

### Multi-doc app — whispering's settings/recordings split

This is the case `createWorkspace` cannot express. Drop to `defineDocument` directly:

```ts
// apps/whispering/src/lib/docs.ts
import { defineDocument, openDocument, attachKv, attachTable, attachIndexedDb, attachSync } from '@epicenter/yjs-doc'

export const settingsDoc = defineDocument('epicenter.whispering.settings', async (ydoc) => {
  const kv = attachKv(ydoc, settingsSchema)

  const idb = attachIndexedDb(ydoc)
  await idb.whenSynced

  const sync = attachSync(ydoc, { url, getToken: () => auth.token })
  return { kv, idb, sync }
})

export const recordingsDoc = defineDocument('epicenter.whispering.recordings', async (ydoc) => {
  const tables = { recordings: attachTable(ydoc, recordingsSchema) }

  const idb = attachIndexedDb(ydoc)
  await idb.whenSynced

  const sync = attachSync(ydoc, { url, getToken: () => auth.token })
  return { tables, idb, sync }
})

// Opening both:
export const settings = await openDocument(settingsDoc)
export const recordings = await openDocument(recordingsDoc)

// Usage:
settings.kv.apiKey.set('sk-...')
recordings.tables.recordings.set({ id, title, blob })
```

The localStorage-for-roamable-settings hack (`apps/whispering/…/kv.ts:188`) goes away. API keys and hardware IDs now live in `settingsDoc`, which syncs.

### Cross-app shared doc — opensidian's skills collapse

Define once in the shared package, open from any app:

```ts
// packages/skills/src/doc.ts
export const skillsDoc = defineDocument('epicenter.skills', async (ydoc) => {
  const tables = { skills: attachTable(ydoc, skillsSchema) }

  const idb = attachIndexedDb(ydoc)
  await idb.whenSynced

  const sync = attachSync(ydoc, { url, getToken: () => auth.token })
  return { tables, idb, sync }
})

// apps/opensidian/src/lib/client.ts — replaces the double-createWorkspace at line 203
export const workspace = createWorkspace(opensidianDef)
  .withExtension('persistence', indexeddbPersistence)
  .withExtension('sync', createSyncExtension({ url, getToken }))

export const skills = await openDocument(skillsDoc)
// skills.tables.skills.set({ ... })
```

Any other app (`whispering`, `honeycrisp`) that imports `@epicenter/skills` and calls `openDocument(skillsDoc)` connects to the same underlying Y.Doc via its stable id. One source of truth for shared state, no duplicated wiring.

### Standalone external consumer

For a Yjs app that doesn't want tables/KV at all:

```ts
import { defineDocument, openDocument } from '@epicenter/yjs-doc'
import * as Y from 'yjs'

const counterDoc = defineDocument('my-counter', async (ydoc) => {
  const state = ydoc.getMap<number>('state')
  ydoc.on('update', () => console.log('count is now', state.get('n')))
  return {
    get: () => state.get('n') ?? 0,
    inc: () => state.set('n', (state.get('n') ?? 0) + 1),
  }
})

const counter = await openDocument(counterDoc)
counter.inc()               // count is now 1
await counter.dispose()
```

This is what SyncedStore ships — but with explicit lifecycle and no schema coupling. No one in the public ecosystem ships this shape.

## How `createWorkspace` Builds on `defineDocument`

The existing builder chain stays. Internally, `createWorkspace(def)` is a thin wrapper that produces a `defineDocument` under the hood:

```ts
// packages/workspace/src/workspace/create-workspace.ts — internal sketch
export function createWorkspace<T extends WorkspaceDefinition>(def: T) {
  const docDef = defineDocument(def.id, async (ydoc) => {
    const tables    = buildTables(ydoc, def.tables)           // existing logic
    const kv        = buildKv(ydoc, def.kv)
    const awareness = buildAwareness(ydoc, def.awareness)
    return { tables, kv, awareness }
  })

  return createBuilder(docDef)  // returns today's WorkspaceClientBuilder
}

// .withExtension('sync', factory) is implemented as:
//   1. Extend the underlying bootstrap so it also runs factory(ydoc, priorCtx) after priors
//   2. Add the factory's return value to the output object under the key
//   3. Preserve progressive ctx typing by threading T through the chain type signatures
```

This means:

- **Zero API surface change for existing apps.** Fuji, honeycrisp, and other single-doc apps don't change their call sites (except removing `.withDocument`, which they migrate off in Phase 2).
- **`.withExtension`, `.withWorkspaceExtension`, `.withDocumentExtension`, `.withActions` all keep working identically.** The three-variant foot-gun is tolerated for now; Phase 3 can consolidate.
- **Progressive extension typing is preserved** because the builder's type parameters accumulate across calls exactly as they do today.
- **Encryption, `clearLocalData`, and `applyEncryptionKeys` work unchanged** because they live in the builder layer, not the primitive.

## What Gets Deleted

| Surface | Status | Reason |
|---|---|---|
| `.withDocument(name, { content, guid, onUpdate })` | **Deleted** | Replaced by separate `defineDocument` + `attachChildDocs` helper. |
| `DocumentConfig`, `DocumentContext` types | **Deleted** | No in-builder doc configs anymore. |
| `create-documents.ts` per-row subdoc manager | **Deleted** (logic ports to `attachChildDocs` helper) | Becomes a userland helper consuming `openDocument`. |
| `ContentStrategy` / `Handle` vocabulary | **Deleted** | Each strategy becomes a thin `attachX(ydoc)` function (`attachRichText`, `attachPlainText`, `attachTimeline`). The hardcoded `ydoc.getText('content')` becomes configurable. |
| `.withDocumentExtension` | **Deleted** | Unused. Doc extensions are now just attach calls inside a doc's bootstrap. |

## What Stays

| Surface | Status |
|---|---|
| `createWorkspace(def)` | Unchanged at call site. Internally wraps `defineDocument`. |
| `.withExtension(key, factory)` | Unchanged. Progressive context typing preserved. |
| `.withWorkspaceExtension(key, factory)` | Unchanged (tolerated until Phase 3 consolidation). |
| `.withActions(factory)` | Unchanged. |
| `defineWorkspace`, `defineTable`, `defineKv`, `defineAwareness` | Unchanged schema builders. |
| Encryption, `applyEncryptionKeys`, `clearLocalData` | Unchanged. Live in the builder layer. |
| All six apps' existing workspace call sites | Unchanged, except removing `.withDocument` in Phase 2. |

## Architecture Diagrams

### Layer split

```
┌──────────────────────────────────────────────────────────────┐
│ packages/workspace                                           │
│ ──────────────────────────────────────────────────────────── │
│ createWorkspace(def)                                         │
│   .withExtension(k, f)      ← unchanged                      │
│   .withActions(f)           ← unchanged                      │
│                                                              │
│ defineWorkspace / defineTable / defineKv / defineAwareness   │
│                                                              │
│ attachChildDocs(parentTable, rowFactory)  ← replaces         │
│                                              .withDocument   │
│                                                              │
│ Encryption, clearLocalData, applyEncryptionKeys              │
└──────────────────────────────────────────────────────────────┘
                             │
                             │  builds on
                             ▼
┌──────────────────────────────────────────────────────────────┐
│ packages/yjs-doc (NEW, standalone)                           │
│ ──────────────────────────────────────────────────────────── │
│ defineDocument(id, async (ydoc) => T): DocumentDefinition<T> │
│ openDocument(def): Promise<T & { ydoc, dispose }>            │
│                                                              │
│ attach helpers: attachTable, attachKv, attachAwareness,      │
│                 attachIndexedDb, attachSync, attachSqlite,   │
│                 attachBroadcastChannel, attachRichText,      │
│                 attachPlainText, attachTimeline              │
│                                                              │
│ Each attach helper:                                          │
│   - sync function: (ydoc, opts) => api                       │
│   - registers ydoc.on('destroy') internally                  │
│   - exposes whenSynced / clearLocal / reconnect as needed    │
└──────────────────────────────────────────────────────────────┘
                             │
                             │  uses
                             ▼
┌──────────────────────────────────────────────────────────────┐
│ yjs (Y.Doc, Y.Map, Y.Text, Y.XmlFragment)                    │
│ Y.Doc emits 'destroy' event — this is the cleanup primitive. │
└──────────────────────────────────────────────────────────────┘
```

### Lifecycle flow

```
STEP 1: defineDocument(id, bootstrap)
        Returns inert { id, bootstrap }. No Y.Doc allocated. Reusable.

STEP 2: openDocument(def)
        1. ydoc = new Y.Doc({ guid: def.id, gc: false })
        2. api = await def.bootstrap(ydoc)
             – User's async function runs linearly
             – Each attach helper registers its cleanup on ydoc.on('destroy')
             – User awaits whenSynced / other readiness signals explicitly
        3. return { ...api, ydoc, dispose }

STEP 3: Consumer uses the API
        counter.inc()
        workspace.tables.entries.set({...})
        settings.kv.apiKey.set('sk-...')

STEP 4: Consumer calls dispose (or the library unmounts)
        ydoc.destroy()
          → fires 'destroy' event
          → every attach helper's cleanup runs
          → providers disconnect, persistence flushes, awareness destroys
```

## Implementation Plan

### Phase 1: Ship the primitive

- [ ] **1.1** Create `packages/yjs-doc` with `defineDocument`, `openDocument` — under 50 lines of production code.
- [ ] **1.2** Extract `attachTable(ydoc, schema)` from `create-workspace.ts:138-147`.
- [ ] **1.3** Extract `attachKv(ydoc, schema)` from `create-workspace.ts:150-152`.
- [ ] **1.4** Extract `attachAwareness(ydoc, schema)` from `create-awareness.ts`.
- [ ] **1.5** Port `attachIndexedDb(ydoc)` from `extensions/persistence/indexeddb.ts`.
- [ ] **1.6** Port `attachSync(ydoc, opts)` from `extensions/sync/websocket.ts`.
- [ ] **1.7** Port `attachBroadcastChannel(ydoc, opts)`.
- [ ] **1.8** Port `attachRichText`, `attachPlainText`, `attachTimeline` from `strategies.ts` — each ~10 lines, with configurable Y.Doc key instead of hardcoded `'content'`.
- [ ] **1.9** Unit tests: lifecycle ordering, destroy fan-out, error propagation.

### Phase 2: Kill `.withDocument` without breaking apps

- [ ] **2.1** Implement `attachChildDocs(parentTable, rowFactory)` helper in `packages/workspace`, built on top of `openDocument`.
- [ ] **2.2** Internal: rewrite `createWorkspace` to construct a `defineDocument` under the hood. All existing builder methods (`.withExtension`, `.withActions`, etc.) preserved. Verify no call-site changes required.
- [ ] **2.3** Migrate fuji off `.withDocument('content', ...)` to `attachChildDocs(workspace.tables.entries, entryContentDoc)`.
- [ ] **2.4** Migrate honeycrisp similarly.
- [ ] **2.5** Migrate filesystem — this unlocks real multi-type support (markdown vs sheet vs canvas), since each row can open a differently-typed content doc.
- [ ] **2.6** Delete `.withDocument`, `DocumentConfig`, `DocumentContext`, `create-documents.ts`.
- [ ] **2.7** Delete `.withDocumentExtension` (unused today).

### Phase 3: Unlock multi-doc and shared docs

- [ ] **3.1** Migrate opensidian: `skills` moves to `openDocument(skillsDoc)` in `packages/skills`; opensidian opens it alongside its workspace.
- [ ] **3.2** Migrate whispering: split into `settingsDoc` + `recordingsDoc`. Remove the localStorage-for-roamable-preferences hack.
- [ ] **3.3** Evaluate `tab-manager` — does `sourceDeviceId` want to become a shared `deviceIdentityDoc`?
- [ ] **3.4** Document the three consumption patterns (single-doc workspace, multi-doc split, cross-app shared).

### Phase 4: Cleanup

- [ ] **4.1** Consider consolidating `.withWorkspaceExtension` into `.withExtension` (now that scope is unambiguous — there's only the workspace Y.Doc to target).
- [ ] **4.2** Ship `packages/yjs-doc` as a standalone npm package for external consumers.
- [ ] **4.3** Write migration guide documenting the `.withDocument` → `attachChildDocs` path.

## Edge Cases

### Sync must await persistence

```ts
const idb = attachIndexedDb(ydoc)
await idb.whenSynced                     // explicit
const sync = attachSync(ydoc, {...})     // starts after idb is hydrated
```

If the bootstrap author forgets `await idb.whenSynced`, sync connects before local state hydrates. This is visible in code review — no hidden `onReady` ordering to get wrong.

### Dispose during async hydration

`openDocument` is awaited before the caller gets a handle. If the caller wants to abort a still-hydrating doc, they need an `AbortSignal`. Defer: wrap `openDocument` in caller-side `Promise.race` if you actually need this. Y.Doc's own lifecycle has no concept of "cancel mid-hydrate" so punting here matches the underlying primitive.

### Cross-app shared doc with diverging schemas

App A ships `skillsDoc` v1. App B upgrades to v2. Both open `epicenter.skills`. Yjs cannot merge incompatible shared-type shapes safely. Schema migrations must be version-gated — this is the same problem the current `defineTable.migrate(...)` pattern solves, and it applies unchanged.

### User forgets to register cleanup in a bootstrap

Bootstrap creates `new Awareness(ydoc)` but doesn't register `ydoc.on('destroy', () => awareness.destroy())`. Memory leak on dispose. Mitigation: use the `attachAwareness(ydoc, schema)` helper, which registers cleanup. No framework enforcement — relies on consistent use of attach helpers over raw construction.

### Per-row content doc leak on row delete

`attachChildDocs` observes the parent table's rows. On row delete, it must close the corresponding child doc. This is non-trivial (existing logic lives in `create-documents.ts:onRowDelete`). The port must preserve it — not simplify it.

### Cross-app shared doc provider config divergence

Opensidian and whispering both open `skillsDoc`. If `skillsDoc` hardcodes `url` and `getToken` in its bootstrap, both apps are locked to one config. Fix: accept config as a parameter to a factory that *returns* a `DocumentDefinition`, not the definition itself:

```ts
export function createSkillsDoc(config: { url: string; getToken: () => Promise<string> }) {
  return defineDocument('epicenter.skills', async (ydoc) => {
    const tables = { skills: attachTable(ydoc, skillsSchema) }
    const idb = attachIndexedDb(ydoc); await idb.whenSynced
    const sync = attachSync(ydoc, config)
    return { tables, idb, sync }
  })
}

// apps/opensidian:
export const skills = await openDocument(createSkillsDoc({ url, getToken }))
```

Shared docs that need per-app configuration become factories. This is a convention, not a primitive change.

## Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Substrate primitive | `defineDocument(id, async (ydoc) => T)` | Closure captures ordering via `await`; typed API returned; no builder needed at this layer. |
| Lifecycle mechanism | `ydoc.on('destroy', fn)` | Native Y.Doc event. No hooks object, no registry, no reinvention. |
| Bootstrap sync or async | **Async** | Lets `await` express ordering (idb before sync). Sync bootstrap would force a hooks-style registry. |
| Hooks object | **Rejected** | Every hook was wrapping a native Y.Doc mechanism. Removing it removes a concept. |
| Providers array | **Rejected** | Attach helpers are just function calls. No array to index, no names to collide. |
| `createWorkspace` at call sites | **Unchanged** | Sugar for the 90% case. Progressive extension typing preserved via existing builder type machinery. |
| `createWorkspace` internals | Wraps `defineDocument` | Two layers, one source of truth for Y.Doc lifecycle. |
| `.withDocument` | **Deleted entirely** | Replaced by separate `defineDocument` + `attachChildDocs` helper. Closure references parent directly. |
| `.withDocumentExtension` | **Deleted** | Unused. Doc extensions are attach calls inside a bootstrap. |
| `.withWorkspaceExtension` | Tolerated (Phase 4 consolidation) | Not blocking. |
| Child-doc lifecycle | `attachChildDocs` userland helper | Not part of the primitive. Opens/closes per row via parent-table observation. |
| Cross-app shared docs | `defineDocument` imported from shared package | Per-app config via factory functions when needed. |
| Standalone package | `packages/yjs-doc` | Enables external consumption. Keeps `packages/workspace` as a pure consumer. |
| LIFO dispose order | Registration order on `'destroy'` event | Sufficient for now. If strict LIFO needed, `openDocument` maintains its own list. |
| `clearLocalData` | Attach-helper-returned method | `doc.idb.clearLocal()`. Coordinated wipe via a `clearAllLocal(doc)` helper that walks known cleanup surfaces. |
| Encryption placement | Stays in builder layer | Phase-4 work; the core redesign ships first. |

## Open Questions

1. **Does `attachChildDocs` need a caching policy?** Opening every row's content doc eagerly would blow up Yjs memory for a large table. The helper likely needs `{ policy: 'eager' | 'lazy' | 'lru' }`. Current `create-documents.ts` is eager — port preserves that, upgrade later.

2. **Do we need `ydoc.on('destroy')` to run LIFO strictly?** Registration order works in current V8 but is not specified. If persistence-before-sync-dispose becomes critical, `openDocument` maintains its own list and iterates it in reverse.

3. **Should attach helpers return `{ api, whenReady, clearLocal, dispose }` uniformly?** Some (idb) expose `whenSynced`; some (sync) expose `reconnect`. No enforced shape. Pro: matches what each thing actually provides. Con: no generic "wait for all ready" helper. Lean: no uniform shape — user awaits what they need.

4. **Does `attachChildDocs` belong in `packages/yjs-doc` or `packages/workspace`?** It depends on `parentTable` being a table helper, which only `packages/workspace` ships. Lean: `packages/workspace`. `packages/yjs-doc` stays pure Y.Doc lifecycle.

5. **Can `.withExtension` disappear if external factories move to attach helpers?** Probably, eventually. Not in this spec — existing apps depend on it. Phase 4 consolidation question.

6. **What happens when two `openDocument(def)` calls hit the same id concurrently?** Two Y.Docs allocated, two sets of providers. Yjs itself handles the sync/persistence layer correctly but the JS-side state is duplicated. Need either an open-doc registry inside `openDocument` or accept the footgun. Lean: registry, keyed by id, ref-counted. Not in the primitive — ships as `packages/yjs-doc`'s default.

## Success Criteria

- [ ] `packages/yjs-doc` ships `defineDocument`, `openDocument` — under 50 lines of production code, zero external dependencies beyond `yjs`.
- [ ] `attachTable`, `attachKv`, `attachIndexedDb`, `attachSync`, `attachBroadcastChannel`, `attachRichText`, `attachPlainText`, `attachTimeline` all functional and unit-tested.
- [ ] `createWorkspace` builds on `defineDocument` internally. Existing app call sites (fuji, honeycrisp, tab-manager, whispering, opensidian, skills) compile unchanged.
- [ ] `.withDocument`, `.withDocumentExtension`, `DocumentConfig`, `DocumentContext`, and `create-documents.ts` are deleted from `packages/workspace`.
- [ ] Fuji and honeycrisp migrate per-row content to `attachChildDocs(...)` with no regression in editor behavior.
- [ ] Opensidian's double-`createWorkspace` at `client.ts:203` collapses to `await openDocument(skillsDoc)`.
- [ ] Whispering splits into `settingsDoc` + `recordingsDoc`. The localStorage-for-roamable-preferences hack in `kv.ts:188` is removed.
- [ ] Filesystem no longer flattens content types to `timeline` — each row opens a per-type content doc.
- [ ] Existing test suites pass (workspace, filesystem, materializer).
- [ ] Documentation covers three consumption patterns: single-doc workspace (unchanged), multi-doc split, cross-app shared.

## References

- `packages/workspace/src/workspace/create-workspace.ts` — Builder; internally wraps `defineDocument` after migration.
- `packages/workspace/src/workspace/create-documents.ts` — Per-row subdoc manager; logic ports to `attachChildDocs` helper, file is deleted.
- `packages/workspace/src/workspace/strategies.ts` — `plainText`/`richText`/`timeline`; each becomes an `attachX(ydoc, opts)` helper with configurable Y.Doc key.
- `packages/workspace/src/workspace/define-table.ts:100-150` — `.withDocument()` declaration; deleted.
- `packages/workspace/src/workspace/lifecycle.ts` — Extension lifecycle; retained for the builder layer, no longer propagates to docs.
- `packages/workspace/src/extensions/persistence/indexeddb.ts` — Ports to `attachIndexedDb(ydoc)`.
- `packages/workspace/src/extensions/persistence/sqlite.ts` — Ports to `attachFilesystem(ydoc, { filePath })`.
- `packages/workspace/src/extensions/sync/websocket.ts` — Ports to `attachSync(ydoc, opts)`.
- `packages/workspace/src/extensions/sync/broadcast-channel.ts` — Ports to `attachBroadcastChannel(ydoc, opts)`.
- `packages/workspace/src/extensions/materializer/sqlite/sqlite.ts` — Ports to `attachSqlite(ydoc, { tables, db })`.
- `apps/fuji/src/lib/workspace.ts` — Simplest migration target. Removes `.withDocument('content', ...)`.
- `apps/opensidian/src/lib/client.ts:203` — Double-`createWorkspace` collapses.
- `apps/whispering/.../kv.ts:188` — Localstorage comment; validation target for settings/recordings split.
- `packages/filesystem/src/table.ts:21-24` — `timeline`-for-everything hack; validation target for multi-type content docs.
- `specs/20260224T141400-local-server-plugin-architecture.md` — Related prior spec on plugin/extension architecture.

## Conversation Journey (for context)

This spec went through multiple shapes before landing here. The final form is substantially simpler than earlier drafts — worth recording what was rejected and why, so a future reader understands the design intent:

1. **Round 1** — Started from "why does `.withDocument('content', { content: richText })` have two `content`s?" Identified naming redundancy, the three-variant `.withExtension` foot-gun, and convention masquerading as config.

2. **Rounds 2-4** — Proposed `defineDocument` as a new primitive. Initially framed as a *replacement* for `createWorkspace`. Audits confirmed the single-Y.Doc ceiling is real (opensidian, whispering evidence).

3. **Round 5** — Overbuilt: the first draft had `emit`, scope-tagged providers, `onDiscriminatorChange`, encrypted defaults, declarative undo config. User correctly called this overbuilt.

4. **Rounds 6-9** — Stripped to a hooks-based IoC model. `defineDocument((ydoc, hooks) => api)` with `hooks: { onReady, onDispose, onUpdate }`. Each audit pass kept trimming ceremony.

5. **Round 10 (the "hooks is a code smell" realization)** — User pushed back: what is `hooks` actually doing? Review found every hook wrapped a native Y.Doc mechanism (`onDispose` → `ydoc.on('destroy')`, `onReady` → `await`, `onUpdate` → a one-liner). Removed the hooks object entirely. The async bootstrap closure plus `ydoc.on('destroy')` is the whole lifecycle story.

6. **Round 11 (the two-layer realization)** — User: "I like how `createWorkspace` works today. The thing I want to fix is the lower level." Reframed: `defineDocument` is the lower primitive, `createWorkspace` is sugar built on top, call sites for single-doc apps don't change. This is what this spec describes.

The repeated pattern: each complication we added was working around an earlier design that was doing too much. The final shape — async bootstrap + Y.Doc destroy event + `createWorkspace` as unchanged sugar — is the first version where nothing feels forced, and the migration path for existing apps is "delete `.withDocument`, port to `attachChildDocs`, done."
