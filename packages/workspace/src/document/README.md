# Workspace Document API

A typed interface over Y.js for apps that need to evolve their data schema over time.

## The Idea

This is a wrapper around Y.js that handles schema versioning. Local-first apps can't run migration scripts, so data has to evolve gracefully. Old data coexists with new. The Workspace API bakes that into the design: define your schemas once with versions, write a migration function, and everything else is typed.

The pattern: a vanilla `openX()` function constructs the workspace's `Y.Doc`, composes `attach*` calls inline, and returns whatever shape your app needs. There's no framework wrapper — just plain functions and the `attach*` primitives. Apps split into `index.ts` (iso doc factory), `<binding>.ts` (env-specific factory adding persistence/sync), and `client.ts` (singleton + lifecycle); see `.claude/skills/workspace-app-layout/SKILL.md`.

```
┌────────────────────────────────────────────────────────────┐
│  Your App                                                  │
├────────────────────────────────────────────────────────────┤
│  function openBlog(): { ydoc, tables, ...; dispose }       │ ← Vanilla factory
├────────────────────────────────────────────────────────────┤
│  attachTable / attachTables / attachKv                     │ ← Data attachments
│  attachEncryption → .attachTable / .attachTables / .attachKv
│  attachAwareness                                           │ ← Presence
│  attachIndexedDb / attachSqlitePersistence / attachBroadcastChannel │ ← Persistence + cross-tab
│  attachSync                                                │ ← WebSocket sync
│  attachSqliteMaterializer                                  │ ← Queryable mirror
├────────────────────────────────────────────────────────────┤
│  Y.Doc (raw CRDT)                                          │ ← Escape hatch
└────────────────────────────────────────────────────────────┘
```

## The Pattern: define vs attach vs create

Three prefixes, each with a consistent meaning:

- **`define*`** is pure — no Y.Doc, no side effects. Schemas, KV definitions, action factories.
- **`attach*`** binds a capability to an existing `Y.Doc` (or, in one documented cross-package case, to a sibling attachment). Side-effectful — registers observers or destroy listeners at call time. Returns a typed handle.
- **`create*`** is pure construction — no listeners, no subscriptions at call time. Two flavors: slot-definition builders (`createTable`, `createKv`, `createAwareness`) that pair with an `attach*` sibling, and factory-of-factories (`createFileContentDocs` in `@epicenter/filesystem`) where the returned handle attaches later.

See `.agents/skills/attach-primitive/SKILL.md` for the full contract (shape, invariants, barrier naming).

```typescript
import * as Y from 'yjs';
import { defineTable, attachTable } from '@epicenter/workspace';
import { type } from 'arktype';

// Pure schema
const postsTable = defineTable(type({ id: 'string', title: 'string', _v: '1' }));

// Vanilla factory: owns Y.Doc creation, composes attachments
function openBlog() {
  const ydoc = new Y.Doc({ guid: 'blog' });
  const tables = {
    posts: attachTable(ydoc, 'posts', postsTable),
  };
  return {
    ydoc,
    tables,
    [Symbol.dispose]() { ydoc.destroy(); },
  };
}

const workspace = openBlog();
workspace.tables.posts.set({ id: '1', title: 'Hello', _v: 1 });
```

## Composing More

The factory body is where you wire everything. Because you own the return shape, you can expose whatever handles your app needs.

### Encryption (client-side E2E)

The encryption coordinator owns sibling attachments — `attachTable` / `attachTables` / `attachKv` are methods on it, not top-level exports.

```typescript
import { attachEncryption } from '@epicenter/workspace';

function openBlog() {
  const ydoc = new Y.Doc({ guid: 'blog' });
  const encryption = attachEncryption(ydoc);
  const tables = encryption.attachTables(ydoc, myTables);
  const kv = encryption.attachKv(ydoc, myKv);
  return { ydoc, tables, kv, encryption, [Symbol.dispose]() { ydoc.destroy(); } };
}
```

### Persistence + sync

```typescript
import {
  attachIndexedDb,
  attachBroadcastChannel,
  attachSync,
} from '@epicenter/workspace';

function openBlog() {
  const ydoc = new Y.Doc({ guid: 'blog' });
  const tables = attachTables(ydoc, myTables);

  const idb = attachIndexedDb(ydoc);
  attachBroadcastChannel(ydoc);
  const sync = attachSync(ydoc, {
    url: `wss://api.example.com/workspaces/${ydoc.guid}`,
    getToken: async () => auth.token,
    waitFor: idb.whenLoaded,
  });

  return {
    ydoc, tables, idb, sync,
    whenReady: idb.whenLoaded,
    [Symbol.dispose]() { ydoc.destroy(); },
  };
}
```

### Awareness

```typescript
import { attachAwareness } from '@epicenter/workspace';

const awareness = attachAwareness(ydoc, myAwarenessDefs);
// awareness.setLocal({...}), awareness.observe(...), awareness.raw for y-protocols
```

### Per-row content documents

Tables stay lean (ids, titles, metadata). Rich content lives in a separate `openContent(guid)` factory keyed on the row's content guid. The row holds the guid; the factory opens a Y.Doc per row on demand. See `apps/fuji/src/lib/entry-content-doc.ts` for the canonical pattern.

## Design Decisions

**Row-level atomicity.** `set()` replaces the entire row. No field-level updates. Every write is a complete row in the latest schema.

**Migration on read, not on write.** Old data transforms when loaded, not when written. Old rows stay old in storage until explicitly rewritten.

**No write validation.** Writes aren't validated at runtime. TypeScript ensures shape; reads validate and return invalid on corruption.

**No field-level observation.** Observe entire tables or KV keys. Let your UI framework handle field reactivity.

**Why `_v` instead of `v`.** Framework metadata prefix — same convention as `_id` in MongoDB. Users intuitively avoid underscore-prefixed fields for business data.

## Testing

Tests live in `*.test.ts` next to the implementation. Use `new Y.Doc()` for in-memory tests. Migrations are validated by reading old data and checking the result.

## Canonical references

- `apps/whispering/src/lib/client.ts` — encryption + IndexedDB + BroadcastChannel + per-row materialization
- `apps/fuji/src/lib/client.ts` — encryption + IndexedDB + sync + awareness
- `packages/workspace/README.md` — quick start
- `packages/workspace/SYNC_ARCHITECTURE.md` — multi-device sync design
