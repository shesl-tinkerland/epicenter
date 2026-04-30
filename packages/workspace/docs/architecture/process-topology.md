# Process Topology

> **Companion docs:** [Network Topology](./network-topology.md) describes how Y.Docs sync between machines (the WAN view). This doc describes how processes on a single machine reach a workspace (the LAN/IPC view). See also [Action Dispatch](./action-dispatch.md) for cross-device action invocation, which rides on top of cloud sync rather than the local socket.

A workspace lives in any process that holds a live `Y.Doc`. Other processes on the same machine need access to that workspace's CRDT state, the actions only one process can run, and the materialized indexes the daemon already maintains. Epicenter solves these with **two transports** that compose:

| Transport | Who uses it | Crosses devices? | Wire |
|---|---|---|---|
| **Cloud Yjs sync (WebSocket)** | Every Y.Doc owner (browser tab, daemon, script) | Yes | binary CRDT updates over WS |
| **Shared filesystem (SQLite WAL + markdown tree)** | Scripts reading the daemon's persistence and materializer files | No (same machine) | SQLite files in WAL mode plus a flat `.md` tree |

Cloud sync is the only sync wire. Scripts open their own short-lived cloud WebSocket and read the daemon's persistence file `{ readonly: true }` for warm hydrate. There is no local IPC sync transport. The first transport is documented in [Network Topology](./network-topology.md). This doc focuses on **the filesystem path** and how it composes with cloud sync to give every process the same workspace handle, with the same call shape on the same data.

## The Three Process Roles

Every Epicenter process plays one of three roles relative to a given workspace. **All three own a real `Y.Doc`.** What differs is which `attach*` primitives bind IO to that doc.

```
┌──────────────┬──────────────────────────────────────────────────────────────┐
│  Role        │  IO it attaches                                              │
├──────────────┼──────────────────────────────────────────────────────────────┤
│  Browser tab │  attachIndexedDb (local persistence)                         │
│  (e.g. fuji) │  attachSync (cloud WebSocket)                                │
│              │  attachAwareness                                             │
├──────────────┼──────────────────────────────────────────────────────────────┤
│  Daemon      │  attachSqlitePersistence (sole writer; durable CRDT log)     │
│  (epicenter  │  attachSync (cloud WebSocket)                                │
│   serve)     │  attachSqliteMaterializer (writes mirror.db, WAL mode)       │
│              │  attachMarkdownMaterializer (writes md/ tree)                │
├──────────────┼──────────────────────────────────────────────────────────────┤
│  Script peer │  attachSqliteReadonlyPersistence (reads daemon's persistence)│
│  (CLI / bun) │  attachSync (own cloud WebSocket)                            │
│              │  attachSqliteMirror (read-only; opens daemon's mirror.db)    │
│              │  attachMarkdownMirror (read-only; reads daemon's md/ tree)   │
└──────────────┴──────────────────────────────────────────────────────────────┘
```

The single most important thing to internalize: **the script is a sibling of the browser tab and the daemon, not a thin client.** All three hold real Y.Docs. All three call `tables.X.set(...)` as a direct, in-process Y.Doc mutation. All three call `attachSync` to converge through the cloud sync server. The script is "special" only in that it is short-lived and reads the daemon's persistence file once at startup to skip a cold-sync.

The daemon also hosts a **synthetic `system` workspace** alongside user workspaces. It is a real Y.Doc with a `workspaces` Y.Map and an Awareness for connected peers; the CLI is a peer of `system`. There is no separate "control protocol"; daemon-wide observability rides the same sync session as everything else.

## Diagram

```
                       ┌─────────────────────────────────┐
                       │  epicenter sync server          │
                       │  apps/api  (Cloudflare/Bun)     │
                       │  - Yjs WebSocket relay          │
                       │  - auth, AI proxy               │
                       └──▲────────────▲────────────▲────┘
                          │ WebSocket  │ WebSocket  │ WebSocket
                          │ attachSync │ attachSync │ attachSync
                          │            │            │
       ┌──────────────────┴────┐  ┌────┴────────────┴───┐  ┌────────────────┐
       │ Browser tab (fuji UI) │  │ epicenter daemon    │  │ Script peer    │
       │ - own Y.Doc           │  │ epicenter serve     │  │ bun script/CLI │
       │ - attachIndexedDb     │  │ - own Y.Doc         │  │ - own Y.Doc    │
       │ - attachSync          │  │ - attachSqlite-     │  │ - attachSqlite-│
       │ - attachAwareness     │  │     Persistence     │  │     Readonly-  │
       │                       │  │ - attachSync        │  │     Persistence│
       │ fuji.tables.X.set()   │  │ - attachSqlite-     │  │ - attachSync   │
       │  ↓                    │  │     Materializer    │  │                │
       │ direct Y.Doc mutate   │  │ - attachMarkdown-   │  │ fuji.tables.   │
       └───────────────────────┘  │     Materializer    │  │   X.set()      │
                                  │                     │  │  ↓             │
                                  │ writes:             │  │ direct Y.Doc   │
                                  │  persistence/<id>.db│  │   mutate       │
                                  │  materializer/<id>  │  │                │
                                  │  md/                │  │ reads:         │
                                  └─────────┬───────────┘  │  persistence/  │
                                            │              │  materializer/ │
                                            │ filesystem   │  md/           │
                                            └──────────────►                │
                                                           └────────────────┘

           Three Y.Doc owners. All three converge through the cloud sync
           server. The daemon owns the persistence and materializer files;
           the script reads them. There is no local IPC; cloud sync is the
           only sync wire.
```

## Two Namespaces on a Script's Workspace Handle

The script's `fuji` handle exposes one universal namespace plus two script-specific ones. Each namespace is backed by a different transport, but the call shape is uniform: import `openFuji` from `@epicenter/fuji/script`, get a handle, call methods.

```
fuji.tables.X        Pure local Y.Doc surface. CRDT writes / reads /
                     observe / batch / closure filters. Identical to the
                     browser tab's `fuji.tables.X`. Mutations flow over
                     the script's own cloud WebSocket; the daemon
                     receives them via its own attachSync, applies to
                     its Y.Doc, and writes to its persistence and
                     materializer files. CRDT is the source of truth.

fuji.sqlite.X        Shared SQLite read. The daemon's
                     attachSqliteMaterializer writes mirror.db with
                     PRAGMA journal_mode = WAL. The script opens the
                     SAME file via attachSqliteMirror with
                     { readonly: true } and gets the full menu: Drizzle
                     for typed query building, raw SQL, FTS5 over the
                     daemon's pre-populated index. Zero round trips,
                     zero cold-start hydration, reuses the daemon's
                     warm index page cache.

fuji.markdown.X      Shared markdown tree. The daemon's
                     attachMarkdownMaterializer writes a flat md/ tree
                     under the workspace dir. The script's
                     attachMarkdownMirror walks that tree (globs,
                     watches, reads) without going through the daemon.
                     Useful for editor integrations and for any tool
                     that wants to consume Epicenter content as plain
                     files.
```

The crucial insight: **everything crosses by filesystem (state read) or cloud (state write).** The daemon owns the persistence file and the materializer projections; scripts read both directly because SQLite WAL mode and the OS filesystem already provide the concurrency primitives we need. Writes flow through `attachSync` to the cloud sync server, which fans out to every connected peer (the daemon included). CRDT is the single source of truth; the daemon is the single writer of derived files.

## Same Call Shape, Different Execution

The workspace API is designed so the **call shape is the same** in browser and script for everything that's a CRDT mutation. What differs is what additional surfaces are exposed and what each surface costs at runtime.

### A) Browser tab

```ts
// apps/fuji/src/lib/fuji/client.ts
import { fuji } from '$lib/fuji/client';   // singleton; owns its Y.Doc

const tabs = fuji.tables.entries.getAllValid();        // sync, in-memory
fuji.tables.entries.set({ id, url });                  // direct Y.Doc mutate
fuji.tables.entries.observe((ids) => rerender(ids));   // live subscription
fuji.tables.entries.filter((r) => r.starred);          // closure, no problem
fuji.batch(() => { /* multiple writes, one transaction */ });
fuji.ydoc.getText('readme').insert(0, '#');            // raw Y.Text access
```

The browser owns its `Y.Doc` and converges with everyone else through the cloud sync server. There is no `fuji.daemon.*`, no `fuji.sqlite.*`, no `fuji.markdown.*`. The browser doesn't need them: it has IndexedDB for persistence and is the source of UI state.

### B) Daemon (started by `epicenter serve`)

The daemon is constructed by *the same builder code* you would call in-process. Its `epicenter.config.ts` runs in the daemon's process and exports a workspace bundle:

```ts
// vault/fuji-example/epicenter.config.ts (excerpt)
import { openFuji } from '@epicenter/fuji/daemon';

export const fuji = openFuji({
  authToken: () => sessionStore.token,
  projectDir: import.meta.dir,
});
export const workspaces = [fuji];
```

`@epicenter/fuji/daemon` internally composes `attachSqlitePersistence` (sole writer; WAL mode), `attachSync` (cloud WebSocket), `attachSqliteMaterializer` (writes mirror.db, WAL), and `attachMarkdownMaterializer` (writes md/ tree). `epicenter serve` loads the config, awaits `whenReady`, and parks. From the outside, it serves three things on the filesystem: the persistence file (readable by scripts), the SQLite materializer file in WAL mode (readable by any process), and the markdown tree (readable by any process). An optional `/run` HTTP RPC server on `daemon.sock` is mounted when enabled (typed action dispatch from CLI, scripts, or curl).

The daemon has no `fuji.sqlite.*` or `fuji.markdown.*` namespace because it doesn't need to read its own materialized state through that path: it owns the `Y.Doc` directly, so it queries via `tables.X` and projects through the materializer. The mirror is for *readers*.

### C) Script peer (bun script / CLI)

```ts
// any bun script in the workspace's folder
import { openFuji } from '@epicenter/fuji/script';

using fuji = await openFuji({ authToken });

// Same call shape as the browser tab:
fuji.tables.entries.set({ id, url });
fuji.tables.entries.observe((ids) => console.log('changed', ids));
fuji.tables.entries.filter((r) => r.starred);
fuji.batch(() => {
  for (const url of inputUrls) {
    fuji.tables.entries.set({ id: crypto.randomUUID(), url });
  }
});
fuji.ydoc.getText('readme').insert(0, '# Hello\n');

// SQLite reads against the daemon's warm mirror (only on the script
// handle; the daemon already has the live Y.Doc):
const top = await fuji.sqlite.drizzle
  .select()
  .from(entries)
  .where(eq(entries.starred, true))
  .limit(50);

const matches = await fuji.sqlite.search('entries', 'rust async');

// Markdown reads against the daemon's md/ tree:
const files = await fuji.markdown.list({ prefix: 'inbox/' });
```

The script's `fuji.tables.entries.set(...)` is **a direct mutation of the script's local Y.Doc**, identical to the browser tab. The script's own `attachSync` observes that mutation and ships it to the cloud sync server. The daemon's `attachSync` receives the update, applies it (its `Y.Doc` advances), the daemon's `attachSqlitePersistence` writes the update to disk, the daemon's `attachSqliteMaterializer` projects it into `mirror.db`, and the daemon's `attachMarkdownMaterializer` writes the new markdown file. Other connected peers (browser tabs, other scripts) see the update through their own cloud sync sessions.

Calls that have no equivalent on the browser tab (`fuji.sqlite.*`, `fuji.markdown.*`) reflect the asymmetry of the actual deployment: the daemon is the local writer of materializer outputs; the script is a local reader and a closure-running scratchpad. We do not pretend these surfaces are universal. They exist on the handle that needs them. Server-only side effects (Stripe calls, kicking peers) flow through Y.Map request entries the daemon observes, or run as typed actions over the daemon's optional `/run` HTTP RPC.

The CLI is the same shape from a shell:

```bash
epicenter serve &                                       # role B in the background
epicenter run savedTabs.create '{"url": "..."}'         # role C, fire-and-forget
epicenter run tables.entries.getAllValid                # role C, read-back
```

`epicenter run` dispatches a typed action against the daemon's `/run` HTTP RPC over `daemon.sock`. The CLI is a thin RPC client; it does not need to construct a Y.Doc just to fire an action. For commands that read `Y.Doc` state (`epicenter list`, `epicenter peers`), the CLI either uses `/run` queries the daemon answers from its in-memory state, or opens a script-shaped peer (`attachSync` + readonly persistence) when the daemon is not running.

## Materialized State Crosses by Filesystem, Not by RPC

This is the structural choice that lets a script feel as fast as the browser tab without re-implementing every read path on the wire. The relevant primitive pairs are:

```
Daemon side                       Script side
───────────                       ───────────
attachSqliteMaterializer    ───►  attachSqliteMirror
  (writer)                          (reader, readonly: true)
   │                                 │
   ▼                                 ▼
   mirror.db (PRAGMA journal_mode = WAL)
   │
   ├─ daemon writes via incremental row inserts as the
   │  Y.Doc updates
   ├─ scripts open the same file with { readonly: true }
   │  and get full Drizzle / raw SQL / FTS5 surface
   └─ WAL allows N concurrent readers + 1 writer with no
      blocking; OS page cache is shared

attachMarkdownMaterializer  ───►  attachMarkdownMirror
  (writer)                          (reader, file walks)
   │                                 │
   ▼                                 ▼
   md/ tree (one file per row, atomic rename)
   │
   ├─ daemon writes synchronously per Yjs updateV2 event;
   │  rename-once-clean for atomic visibility
   ├─ scripts list and read the tree directly (no watch
   │  surface in v3; cross-platform fs.watch deferred)
   └─ no socket round-trip per file read
```

What this gets you that an RPC mirror would not:

- **Zero round trips per query.** A `SELECT ... WHERE ... LIMIT 50` against the mirror is one SQLite call. Marshalling rows through the unix socket would be ten thousand bytes one way and ten thousand bytes back. Local SQLite with shared OS page cache is faster than any RPC layer the daemon could expose.
- **Full client menu, no proxy gymnastics.** Drizzle's query builder, raw SQL, FTS5 with `MATCH`, transaction blocks: all available in the script because the script is just opening a SQLite file. There is no "the wire-callable subset" to maintain. The reader uses the database client directly.
- **Warm cache reuse.** The daemon has been running for hours; its OS page cache for `mirror.db` is hot. The script's SQLite open hits that cache. A self-contained "every script its own SQLite" approach would re-warm from cold disk on every invocation.
- **No Y.Doc hydration on the read path.** A script that only needs to *read* state does not have to construct a Y.Doc at all; it opens the mirror SQLite file directly. Constructing a Y.Doc to satisfy a query would mean paying `Y.applyUpdate` of the full state on every cold script invocation; reading the mirror skips that entirely.

What this **does not change**: writes still flow through `Y.Doc`. The CRDT is the single source of truth. The mirror is exactly that: a one-way projection the daemon maintains. A script that wants to write does it via `fuji.tables.X.set(...)`, not by `INSERT INTO entries ...`. (In fact, the mirror file is opened `readonly: true` for scripts, which means trying to write through it errors with a SQLite read-only failure rather than diverging from the CRDT silently.)

## Why the Daemon Exists

A reasonable instinct: "Why does the daemon exist? Couldn't a script just attach its own Y.Doc and its own cloud sync, like the browser tab does?"

It can, and in fact it does. The script-side `openFuji` factory composes exactly that: `attachSync` + `attachSqliteReadonlyPersistence`. The daemon is load-bearing only for two roles:

1. **Single-writer for the persistence file.** `attachSqlitePersistence` is append-only. Two processes calling it on the same file would race on WAL checkpoints and on the compaction debounce. The daemon claims sole-writer status; scripts open the file `{ readonly: true }`. SQLite's WAL mode lets N readers proceed concurrently with the writer, no `SQLITE_BUSY`, no coordination. Same shape libsql uses for multi-process SQLite (`sqld`).
2. **Materializer side-effects.** `mirror.db` and `md/` are projections of the Y.Doc, written by the daemon as updates flow in. Scripts read these for fast SQL queries (Drizzle, FTS5) and direct file reads. Without a daemon, scripts wanting these projections would each have to maintain their own materializer, which defeats the warm-page-cache benefit.

The two reasons that *sound* like daemon arguments but aren't:

- **Cold-start hydration is not a daemon-IPC win.** A cold script paying `Y.applyUpdate` of the full state pays the same cost whether bytes come from local SQLite or from a daemon over IPC; the apply dominates either way. The persistence file gives scripts warm hydrate; cloud sync gives them deltas. There is no IPC sync wire because there is no benefit from one.
- **clientID accumulation is fixed peer-side, not by the daemon.** Random `clientID` per `new Y.Doc()` accumulates one StructStore entry per process invocation forever. The fix is `hashClientId(Bun.main)` (`packages/workspace/src/shared/client-id.ts`): two invocations of the same script reuse the same clientID. This works whether or not there's a daemon.

So the daemon exists to **be the sole writer of the persistence and materializer files**. Cloud sync is the only sync wire. Scripts join the cloud session directly and read the daemon's files for warm hydrate and SQL/markdown queries. Two transports (cloud WebSocket plus shared filesystem), each carrying what it carries best, composed into one workspace handle with one call shape.

## Cross-References

- [README §Sync](../../README.md#sync): the `attachSync` primitive both Y.Doc owners use to reach the cloud sync server.
- [Network Topology](./network-topology.md): the WAN-side picture; how Y.Doc owners (browser tabs, daemons) converge across machines via the cloud sync server.
- [Action Dispatch](./action-dispatch.md): cross-device action invocation via the Y.Doc requests mailbox; the third transport, used when an action must run on a *specific* peer rather than the local daemon.
- [Device Identity](./device-identity.md): how peers and the daemon identify themselves to the cloud sync server and to each other.
- [Security](./security.md): trust boundaries between processes, the cloud sync server, the unix socket, and the shared mirror files on disk.
- `packages/cli/src/commands/serve.ts`: the daemon entry point.
- `packages/workspace/src/document/attach-sqlite-persistence.ts`: daemon's sole writer of the CRDT log.
- `packages/workspace/src/document/attach-sqlite-readonly-persistence.ts`: script-side reader for warm hydrate.
- `packages/workspace/src/document/attach-sync.ts`: cloud Yjs sync (the only sync wire).
- `packages/workspace/src/client/sqlite-mirror.ts`: `attachSqliteMirror` (script-side reader of `mirror.db`).
- `packages/workspace/src/client/markdown-mirror.ts`: `attachMarkdownMirror` (script-side reader of the `md/` tree).
- `packages/workspace/src/document/materializer/sqlite/`: `attachSqliteMaterializer` (writer).
- `packages/workspace/src/document/materializer/markdown/`: `attachMarkdownMaterializer` (writer).
