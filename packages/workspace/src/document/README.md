# Workspace Document API

A typed interface over Y.js for apps that need to evolve their data schema over time.

## The Idea

This is a wrapper around Y.js that handles schema versioning. Local-first apps can't run migration scripts, so data has to evolve gracefully. Old data coexists with new. The Workspace API bakes that into the design: define your schemas once with versions, write a migration function, and everything else is typed.

The pattern: a vanilla `openX()` function constructs the workspace's `Y.Doc`, composes `attach*` calls inline, and returns whatever shape your app needs. There is no framework wrapper, just plain functions and the `attach*` primitives. Apps split factory code into `index.ts` (iso doc factory) and `<binding>.ts` (env-specific factory adding persistence/sync). Runtime lifecycle then lives in `session.svelte.ts` for SvelteKit signed-in apps or `client.ts` for singleton clients; see `.claude/skills/workspace-app-layout/SKILL.md`.

```
+----------------------------------------------------------------+
| Your App                                                       |
+----------------------------------------------------------------+
| function openBlog(): { ydoc, tables, ...; dispose }            |
+----------------------------------------------------------------+
| attachTable / attachTables / attachKv                          |
| attachEncryption -> .attachTable / .attachTables / .attachKv    |
| attachIndexedDb / attachYjsLog / attachBroadcastChannel        |
| LocalOwner -> attachIndexedDb / attachBroadcastChannel / wipe   |
| openCollaboration (sync + presence + RPC + peers; actions: {} for content docs)|
| attachSqliteMaterializer                                       |
+----------------------------------------------------------------+
| Y.Doc (raw CRDT)                                               |
+----------------------------------------------------------------+
```

## The Pattern: define vs attach vs create

Three prefixes, each with a consistent meaning:

- **`define*`** is pure: no Y.Doc, no side effects. Schemas, KV definitions, action factories.
- **`attach*`** binds a capability to an existing `Y.Doc` (or, in one documented cross-package case, to a sibling attachment). Side-effectful: registers observers or destroy listeners at call time. Returns a typed handle.
- **`create*`** is pure construction: no listeners, no subscriptions at call time. Primitives like `createDisposableCache` return handles that attach later.

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

The encryption coordinator owns sibling attachments: `attachTable` / `attachTables` / `attachKv` are methods on it, not top-level exports.

```typescript
import { attachEncryption } from '@epicenter/workspace';
import type { SubjectKeyring } from '@epicenter/encryption';

function openBlog({ keyring }: { keyring: () => SubjectKeyring }) {
  const ydoc = new Y.Doc({ guid: 'blog' });
  const encryption = attachEncryption(ydoc, { keyring });
  const tables = encryption.attachTables(myTables);
  const kv = encryption.attachKv(myKv);
  return { ydoc, tables, kv, encryption, [Symbol.dispose]() { ydoc.destroy(); } };
}
```

### Persistence + collaboration

Auth belongs to the app. The workspace factory receives an auth-owned WebSocket
opener and passes it to `openCollaboration`, which wraps the sync supervisor,
publishes peer identity in awareness, dispatches inbound action and runtime
requests, and exposes a `peers` surface for cross-peer dispatch.

```typescript
import {
  type LocalOwner,
  openCollaboration,
  roomWsUrl,
} from '@epicenter/workspace';

function openBlog({
  owner,
  openWebSocket,
}: {
  owner: LocalOwner;
  openWebSocket?: (
    url: string | URL,
    protocols?: string[],
  ) => WebSocket | Promise<WebSocket>;
}) {
  const ydoc = new Y.Doc({ guid: 'blog' });
  const tables = attachTables(ydoc, myTables);
  const idb = owner.attachIndexedDb(ydoc);
  owner.attachBroadcastChannel(ydoc);
  const collaboration = openCollaboration(ydoc, {
    url: roomWsUrl('https://api.example.com', ydoc.guid),
    openWebSocket,
    waitFor: idb.whenLoaded,
    replicaId: 'browser',
    actions: {},
  });

  return {
    ydoc, tables, idb, collaboration,
    [Symbol.dispose]() { ydoc.destroy(); },
  };
}
```

For content documents (rich-text bodies, attachments) that only need bytes-on-the-wire, use `openCollaboration` with an empty `actions: {}` registry. The action runner is skipped entirely; the byte transport is identical, and the workspace's presence/RPC arrays simply stay empty.

### Per-row content documents

Tables stay lean (ids, titles, metadata). Rich content lives in a separate `openContent(guid)` factory keyed on the row's content guid. The row holds the guid; the factory opens a Y.Doc per row on demand. See `apps/fuji/src/lib/entry-content-doc.ts` for the canonical pattern.

## Design Decisions

**Row-level atomicity.** `set()` replaces the entire row. No field-level updates. Every write is a complete row in the latest schema.

**Migration on read, not on write.** Old data transforms when loaded, not when written. Old rows stay old in storage until explicitly rewritten.

**No write validation.** Writes aren't validated at runtime. TypeScript ensures shape; reads validate and return invalid on corruption.

**No field-level observation.** Observe entire tables or KV keys. Let your UI framework handle field reactivity.

**Why `_v` instead of `v`.** Framework metadata prefix: same convention as `_id` in MongoDB. Users intuitively avoid underscore-prefixed fields for business data.

## Testing

Tests live in `*.test.ts` next to the implementation. Use `new Y.Doc()` for in-memory tests. Migrations are validated by reading old data and checking the result.

## Canonical references

- `apps/whispering/src/lib/client.ts`: encryption + IndexedDB + BroadcastChannel + per-row materialization
- `apps/fuji/src/lib/client.ts`: encryption + IndexedDB + sync + awareness
- `packages/workspace/README.md`: quick start
- `packages/workspace/SYNC_ARCHITECTURE.md`: multi-device sync design
