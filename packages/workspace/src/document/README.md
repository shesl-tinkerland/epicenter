# Workspace Document API

A typed interface over Y.js for apps that need to evolve their data schema over time.

## The Idea

This is a wrapper around Y.js that handles schema versioning. Local-first apps can't run migration scripts, so data has to evolve gracefully. Old data coexists with new. The Workspace API bakes that into the design: define your schemas once with versions, write a migration function, and everything else is typed.

The pattern: `createWorkspace({ id, tables, kv, keyring? })` constructs the low-level workspace `Y.Doc` with tables and KV mounted. Apps wrap that in `create<App>Workspace()` to define the shared isomorphic model: id, tables, actions, deterministic child docs, and disposal. Runtime openers such as `open<App>Browser()`, `open<App>Daemon()`, and `open<App>Tauri()` compose additional `attach*` / `open*` primitives around that model and return the exact shape the runtime needs. Use `defineWorkspace()` when returning a composed bundle so TypeScript preserves the inferred shape after spreads.

```
+----------------------------------------------------------------+
| Your App                                                       |
+----------------------------------------------------------------+
| create<App>Workspace(): shared model                              |
| open<App>Browser/Daemon/Tauri(): runtime attachments              |
+----------------------------------------------------------------+
| createWorkspace({ id, tables, kv, keyring? })                  |
|   -> { ydoc, tables, kv, actions, [Symbol.dispose] }           |
| attachIndexedDb / attachYjsLog / attachBroadcastChannel        |
| attachLocalStorage(ydoc, { server, ownerId, keyring })  // encrypted IDB + scoped BC |
| wipeLocalStorage({ server, ownerId })           // delete local data for owner |
| openCollaboration (sync + presence + dispatch)                 |
| attachBunSqliteMaterializer / attachMarkdownMaterializer       |
+----------------------------------------------------------------+
| Y.Doc (raw CRDT)                                               |
+----------------------------------------------------------------+
```

## The Pattern: define vs create vs open vs attach

Three prefixes, each with a consistent meaning:

- **`define*`** is pure: no Y.Doc, no side effects. Schemas, KV definitions, action factories, or type-preserving wrappers such as `defineWorkspace`.
- **`create*`** constructs a model, registry, or cache. `createWorkspace` creates the low-level Y.Doc bundle; `create<App>Workspace` creates an app's shared isomorphic model.
- **`open*`** constructs or receives a model and attaches runtime lifecycle: browser storage, daemon sync, SQLite readers, or Tauri services.
- **`attach*`** binds a capability to an existing `Y.Doc` (or, in one documented cross-package case, to a sibling attachment). Side-effectful: registers observers or destroy listeners at call time. Returns a typed handle.

See `.agents/skills/attach-primitive/SKILL.md` for the full contract (shape, invariants, barrier naming).

```typescript
import { column, createWorkspace, defineTable } from '@epicenter/workspace';

// Pure schema. `_v` is library-managed: never declare it as a column.
const postsTable = defineTable({
  id: column.string(),
  title: column.string(),
});

// Vanilla factory: createWorkspace owns Y.Doc creation; the factory composes
// any extra attachments your app needs and returns the bundle.
function openBlog() {
  return createWorkspace({
    id: 'blog',
    tables: { posts: postsTable },
    kv: {},
  });
}

using workspace = openBlog();
workspace.tables.posts.set({ id: '1', title: 'Hello' });
```

## Composing More

The factory body is where you wire everything. Because you own the return shape, you can expose whatever handles your app needs.

### Encryption (server-managed value encryption)

Pass a `keyring: () => Keyring` callback to `createWorkspace`. The keyring is read once at construction, narrowed to `id` via HKDF, and shared across every table and the KV store. Omit it for plaintext.

```typescript
import { createWorkspace, type Keyring } from '@epicenter/workspace';

function openBlog({ keyring }: { keyring: () => Keyring }) {
  return createWorkspace({
    id: 'blog',
    keyring,
    tables: myTables,
    kv: myKv,
  });
}
```

### Persistence + collaboration

Auth belongs to the app. The workspace factory receives the signed-in identity
(`ownerId` + `keyring` + transport functions) and a WebSocket opener, then passes them to
`attachLocalStorage` and `openCollaboration`. `openCollaboration` wraps the
sync supervisor, mirrors the relay's server-owned presence channel as
`devices`, and runs inbound dispatch frames against the local action registry.

```typescript
import type { SignedIn } from '@epicenter/svelte';
import {
  attachLocalStorage,
  createWorkspace,
  openCollaboration,
  roomWsUrl,
  wipeLocalStorage,
} from '@epicenter/workspace';

function openBlog({
  signedIn,
  deviceId,
}: {
  signedIn: SignedIn;
  deviceId: string;
}) {
  const workspace = createWorkspace({
    id: 'blog',
    keyring: signedIn.keyring,
    tables: myTables,
    kv: {},
  });

  // Server + owner scoped encrypted IDB + cross-tab BroadcastChannel in one call.
  const idb = attachLocalStorage(workspace.ydoc, {
    server: signedIn.server,
    ownerId: signedIn.ownerId,
    keyring: signedIn.keyring,
  });

  const collaboration = openCollaboration(workspace.ydoc, {
    url: roomWsUrl({
      baseURL: signedIn.baseURL,
      ownerId: signedIn.ownerId,
      guid: workspace.ydoc.guid,
      deviceId,
    }),
    openWebSocket: signedIn.openWebSocket,
    onReconnectSignal: signedIn.onReconnectSignal,
    waitFor: idb.whenLoaded,
    actions: {},
  });

  return {
    ...workspace,
    idb,
    collaboration,
    async wipe() {
      workspace[Symbol.dispose]();
      await Promise.all([idb.whenDisposed, collaboration.whenDisposed]);
      await wipeLocalStorage({
        server: signedIn.server,
        ownerId: signedIn.ownerId,
      });
    },
  };
}
```

`attachLocalStorage(ydoc, { server, ownerId, keyring })` derives the IDB
database name and BroadcastChannel key from `server` + `ownerId` + `ydoc.guid`
under a single durable prefix, so two signed-in owners on the same browser
profile never share local storage or exchange plaintext cross-tab updates.
`wipeLocalStorage` deletes every database under that prefix in one call: no
explicit guid list to maintain.

For content documents (rich-text bodies, attachments) that only need bytes-on-the-wire, use `openCollaboration` with an empty `actions: {}` registry. Inbound dispatch frames reply `ActionNotFound`; the byte transport and presence channel are identical.

### Per-row content documents

Tables stay lean (ids, titles, metadata). Rich content lives in a separate per-row content cache keyed on the row's content guid. The row holds the guid; the cache opens a Y.Doc per row on demand. See `apps/fuji/src/lib/browser.ts` for the canonical pattern.

## Design Decisions

**Row-level atomicity.** `set()` replaces the entire row. No field-level updates. Every write is a complete row in the latest schema.

**Migration on read, not on write.** Old data transforms when loaded, not when written. Old rows stay old in storage until explicitly rewritten.

**No write validation.** Writes aren't validated at runtime. TypeScript ensures shape; reads validate and return invalid on corruption.

**No field-level observation.** Observe entire tables or KV keys. Let your UI framework handle field reactivity.

**Why `_v` instead of `v`.** The library-managed version field uses a framework metadata prefix, the same convention as `_id` in MongoDB. Users never declare or read `_v`; the library stamps it on every write and strips it on every read. The underscore makes the reserved key visually distinct in storage dumps.

## Testing

Tests live in `*.test.ts` next to the implementation. Use `createWorkspace({ id: 'test', tables, kv: {} })` for in-memory tests; `using workspace = ...` cascades disposal of every store. Migrations are validated by reading old data and checking the result.

## Canonical references

- `apps/whispering/src/lib/whispering/client.tauri.ts`: IndexedDB + BroadcastChannel + recording markdown export
- `apps/fuji/src/lib/browser.ts`: encryption + IndexedDB + sync + server-owned presence
- `packages/workspace/README.md`: quick start
- `packages/workspace/SYNC_ARCHITECTURE.md`: multi-device sync design
