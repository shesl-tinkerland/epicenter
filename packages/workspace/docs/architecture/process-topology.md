# Process Topology

> **Companion docs:** [Network Topology](./network-topology.md) describes how Y.Docs sync between machines (the WAN view). This doc describes how processes on a single machine reach a workspace (the LAN/IPC view). See also [Action Dispatch](./action-dispatch.md) for cross-device action invocation, which rides on top of cloud sync rather than the local socket.

A workspace lives in any process that holds a live `Y.Doc`. Other processes on the same machine need access to that workspace's CRDT state, the actions only one process can run, and the materialized indexes the daemon already maintains. Epicenter solves all three with **three transports** that compose:

| Transport | Who uses it | Crosses devices? | Wire |
|---|---|---|---|
| **Cloud Yjs sync (WebSocket)** | Y.Doc owners converging across machines | Yes | binary CRDT updates over WS |
| **Local Yjs sync over unix socket** | Script peer to daemon CRDT, plus `MESSAGE_TYPE.RPC` mailbox frames | No (same machine) | length-prefixed binary frames on `daemon.sock` |
| **Shared filesystem (SQLite WAL + markdown tree)** | Scripts reading materialized state the daemon already maintains | No (same machine) | SQLite file in WAL mode plus a flat `.md` tree |

The first transport is documented in [Network Topology](./network-topology.md) and is unchanged. This doc focuses on **the second and third** and how they compose with the first to give every process the same workspace handle, with the same call shape on the same data, regardless of where the bytes actually live.

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
│  Daemon      │  attachSqlite (durable on-disk CRDT log)                     │
│  (epicenter  │  attachSync (cloud WebSocket)                                │
│   serve)     │  attachSqliteMaterializer (writes mirror.db, WAL mode)       │
│              │  attachMarkdownMaterializer (writes md/ tree)                │
│              │  attachSyncHub (serves local peers on daemon.sock)           │
├──────────────┼──────────────────────────────────────────────────────────────┤
│  Script peer │  attachSyncIpc (peers the daemon over daemon.sock)           │
│  (CLI / bun) │  attachSqliteMirror (read-only; opens daemon's mirror.db)    │
│              │  attachMarkdownMirror (read-only; reads daemon's md/ tree)   │
└──────────────┴──────────────────────────────────────────────────────────────┘
```

The single most important thing to internalize: **the script is a sibling of the browser tab and the daemon, not a thin client.** All three hold real Y.Docs. All three call `tables.X.set(...)` as a direct, in-process Y.Doc mutation. The script's writes happen to be observed by `attachSyncIpc` and shipped to the daemon as Yjs `update` messages, the same way the browser tab's writes are observed by `attachSync` and shipped to the cloud sync server. Both are sync clients of something; only the something differs.

The daemon also hosts a **synthetic `system` workspace** alongside user workspaces. It is a real Y.Doc with a `workspaces` Y.Map and an Awareness for connected peers; the CLI is a peer of `system`. There is no separate "control protocol"; daemon-wide observability rides the same sync session as everything else.

## Diagram

```
                       ┌─────────────────────────────────┐
                       │  epicenter sync server          │
                       │  apps/api  (Cloudflare/Bun)     │
                       │  - Yjs WebSocket relay          │
                       │  - auth, AI proxy               │
                       └───────▲─────────────────▲───────┘
                               │ WebSocket       │ WebSocket
                               │ (attachSync)    │ (attachSync)
                               │                 │
            ┌──────────────────┴──────┐   ┌──────┴───────────────────────┐
            │  Browser tab (fuji UI)  │   │  epicenter daemon            │
            │  - own Y.Doc            │   │  started by `epicenter serve`│
            │  - attachIndexedDb      │   │  - own Y.Doc                 │
            │  - attachSync           │   │  - attachSqlite (CRDT log)   │
            │  - attachAwareness      │   │  - attachSync                │
            │                         │   │  - attachSqliteMaterializer  │
            │  fuji.tables.X.set()    │   │  - attachMarkdownMaterializer│
            │   ↓                     │   │  - attachSyncHub             │
            │  direct Y.Doc mutate    │   │                              │
            └─────────────────────────┘   │  fuji.tables.X.set()         │
                                          │   ↓                          │
                                          │  direct Y.Doc mutate         │
                                          └─┬────────────┬───────────────┘
                                            │            │
                                            │ unix       │ files: mirror.db (WAL),
                                            │ socket     │        md/ tree
                                            │ daemon     │
                                            │ .sock      │
                                            ▼            ▼
                                     ┌─────────────────────────────────┐
                                     │  Script peer (bun script / CLI) │
                                     │  - own Y.Doc                    │
                                     │  - attachSyncIpc (CRDT + RPC)   │
                                     │  - attachSqliteMirror (RO file) │
                                     │  - attachMarkdownMirror (RO)    │
                                     └─────────────────────────────────┘

                       Three Y.Doc owners. Browser tab and daemon
                       converge through the cloud sync server. The
                       script converges with the daemon over the unix
                       socket, then transitively with the rest through
                       the daemon. Materialized state (mirror.db, md/)
                       crosses the script boundary by filesystem, not
                       by RPC.
```

## Three Namespaces on a Script's Workspace Handle

The script's `fuji` handle exposes one universal namespace plus three script-specific ones. Each namespace is backed by a different transport, but the call shape is uniform: import `openFujiPeer`, get a handle, call methods.

```
fuji.tables.X        Pure local Y.Doc surface. CRDT writes / reads /
                     observe / batch / closure filters. Identical to the
                     browser tab's `fuji.tables.X`. Mutations flow to
                     the daemon as Yjs update frames over the unix
                     socket; the daemon redistributes them to the cloud
                     and to other local peers. CRDT is the source of
                     truth.

fuji.daemon.X        RPC mailbox over the same sync session. Used ONLY
                     for daemon-only WRITES: actions that require
                     daemon-side state the script has no business
                     holding (auth tokens, external API keys, the
                     ability to kick another peer on the system
                     workspace). Frames carry MESSAGE_TYPE.RPC inside
                     the existing length-prefix wire.

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

The crucial insight: **materialized state crosses by filesystem, not by RPC.** The daemon already maintains a queryable mirror and a readable markdown tree. Sending those across a socket to a script would be redundant work; the script can open the daemon's files directly because SQLite WAL mode and the OS filesystem already provide the concurrency primitives we need. Writes still flow through Y.Doc (CRDT is the source of truth), but reads of derived state are direct.

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
// playground/opensidian-e2e/epicenter.config.ts (excerpt)
import {
  attachEncryption,
  attachSqlite,
  attachSync,
  attachSqliteMaterializer,
  attachMarkdownMaterializer,
  attachSyncHub,
  toWsUrl,
} from '@epicenter/workspace';

const ydoc = new Y.Doc({ guid: WORKSPACE_ID });
const tables = attachEncryption(ydoc).attachTables(ydoc, opensidianTables);
attachSqlite(ydoc, persistencePath(absDir));            // CRDT log
attachSync(ydoc, { url: toWsUrl(`${SERVER_URL}/...`), ... });
attachSqliteMaterializer(ydoc, { db: openMirror(absDir) }) // mirror.db (WAL)
  .table(tables.entries, { fts: ['title', 'body'] });
attachMarkdownMaterializer(ydoc, { rootDir: mdDir(absDir) });
attachSyncHub({ socket: socketPathFor(absDir), workspaces: [...] });

export const opensidian = { whenReady, actions, sync, tables, ydoc, ... };
```

`epicenter serve` loads this file, awaits `whenReady`, and parks. From the daemon's own perspective, it is a Y.Doc-owning process that calls the same `tables.X` methods as the browser. From the outside, it serves three things on the filesystem: the unix socket (for CRDT sync and RPC mailbox), the SQLite mirror file in WAL mode (readable by any process), and the markdown tree (readable by any process).

The daemon has no `fuji.sqlite.*` or `fuji.markdown.*` namespace because it doesn't need to read its own materialized state through that path: it owns the `Y.Doc` directly, so it queries via `tables.X` and projects through the materializer. The mirror is for *readers*.

### C) Script peer (bun script / CLI)

```ts
// any bun script in the workspace's folder
import { openFujiPeer } from '@apps/fuji';

await using fuji = await openFujiPeer();

// Same call shape as the browser tab:
fuji.tables.entries.set({ id, url });
fuji.tables.entries.observe((ids) => console.log('changed', ids));
fuji.tables.entries.filter((r) => !r.tagged);
fuji.batch(() => {
  for (const e of fuji.tables.entries.filter(x => !x.tagged)) {
    fuji.tables.entries.update(e.id, { tagged: true });
  }
});
fuji.ydoc.getText('readme').insert(0, '# Hello\n');

// Daemon-only writes (only on the script handle; the daemon doesn't
// need to mailbox-call itself):
await fuji.daemon.sendInvoice({ entryId, recipient });

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

The script's `fuji.tables.entries.set(...)` is **a direct mutation of the script's local Y.Doc**, identical to the browser tab. `attachSyncIpc` observes that mutation and ships it to the daemon as a Yjs `update` frame. The daemon applies it (its `Y.Doc` advances), the daemon's `attachSync` ships it to the cloud, the daemon's `attachSqliteMaterializer` projects it into `mirror.db`, the daemon's `attachMarkdownMaterializer` writes the new markdown file. Other connected peers see the update over their own `attachSyncIpc` sessions.

Calls that have no equivalent on the browser tab (`fuji.daemon.*`, `fuji.sqlite.*`, `fuji.markdown.*`) reflect the asymmetry of the actual deployment: the daemon is the local writer of mirrors and the holder of secrets; the script is the local reader and the local closure-running scratchpad. We do not pretend these surfaces are universal. They exist on the handle that needs them.

The CLI is the same shape from a shell:

```bash
epicenter serve &                                       # role B in the background
epicenter run savedTabs.create '{"url": "..."}'         # role C, fire-and-forget
epicenter run tables.entries.getAllValid                # role C, read-back
```

`epicenter run` opens an ephemeral peer per invocation (`attachSyncIpc` against the local daemon), invokes the action, and exits. The CLI is just a script-shaped peer with a shell-friendly argv parser. `epicenter peers` and `epicenter list` open a peer of the synthetic `system` workspace and read its Awareness / `workspaces` Y.Map.

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
  (writer)                          (reader, file walks + watch)
   │                                 │
   ▼                                 ▼
   md/ tree (one file per row, atomic rename)
   │
   ├─ daemon writes via debounced flush; rename-once-clean
   ├─ scripts glob, read, and watch the tree directly
   │  (chokidar; cross-platform fs.watch is too brittle)
   └─ no socket round-trip per file read
```

What this gets you that an RPC mirror would not:

- **Zero round trips per query.** A `SELECT ... WHERE ... LIMIT 50` against the mirror is one SQLite call. Marshalling rows through the unix socket would be ten thousand bytes one way and ten thousand bytes back. Local SQLite with shared OS page cache is faster than any RPC layer the daemon could expose.
- **Full client menu, no proxy gymnastics.** Drizzle's query builder, raw SQL, FTS5 with `MATCH`, transaction blocks: all available in the script because the script is just opening a SQLite file. There is no "the wire-callable subset" to maintain. The reader uses the database client directly.
- **Warm cache reuse.** The daemon has been running for hours; its OS page cache for `mirror.db` is hot. The script's SQLite open hits that cache. A self-contained "every script its own SQLite" approach would re-warm from cold disk on every invocation.
- **No cold-start hydration.** Opening a SQLite file is microseconds. Hydrating a 50 MB Y.Doc from a fresh process is seconds.

What this **does not change**: writes still flow through `Y.Doc`. The CRDT is the single source of truth. The mirror is exactly that: a one-way projection the daemon maintains. A script that wants to write does it via `fuji.tables.X.set(...)`, not by `INSERT INTO entries ...`. (In fact, the mirror file is opened `readonly: true` for scripts, which means trying to write through it errors with a SQLite read-only failure rather than diverging from the CRDT silently.)

## Why Three Transports

A reasonable instinct: "Why does the daemon exist? Couldn't a script just attach its own Y.Doc, its own SQLite, its own cloud sync, like the browser tab does?"

It could not, and the failure modes are concrete:

1. **SQLite is single-writer.** Two processes calling `attachSqlite` on the same file race on WAL checkpoints; the StructStore corrupts. Whenever the ecosystem wants multi-process SQLite, the answer keeps coming back as a daemon (libsql shipped `sqld` for this exact reason).
2. **Cloud WebSocket fan-out.** Ten concurrent scripts mean ten WebSocket connections to the sync server. Cloudflare Durable Objects bill per connection, and the y-websocket / hocuspocus / partykit ecosystem is hub-and-spoke for the same reason: one connection per device.
3. **Cold-start hydration.** A 50 MB Y.Doc loads from SQLite in roughly 1.5 seconds. Multiply by every `bun run script.ts` invocation. A daemon already has the doc in memory; a peer connecting over a unix socket only ships the state-vector diff, which is ~50 ms on a warm doc.
4. **clientID accumulation.** Every Y.Doc has a random `clientID` that Yjs retains forever in the StructStore (CRDT causality is unbounded). Fresh process per script means fresh random clientID per invocation; 1000 invocations means 1000 permanent entries shipped on every cold-start sync. `attachSyncIpc` derives a stable clientID from the script's entry-point path, so two invocations of the same script reuse the same id.
5. **Encryption boundary.** The daemon holds the workspace's encryption keys. Forking that key material into every shell script (so each can talk to the cloud independently) is worse for security than keeping it in one long-lived process and granting filesystem-permissioned IPC.

So the daemon exists to **amortize the cost of being a sync client and a SQLite writer** for the local machine. Browsers pay the sync-client cost themselves because they are already a long-lived UI process. Scripts piggyback on the daemon for both: they get CRDT convergence over the unix socket, they get queryable state via the shared mirror file, and they get markdown reads via the shared tree. Three transports, each carrying what it carries best, composed into one workspace handle with one call shape.

## Cross-References

- [README §Sync](../../README.md#sync): the `attachSync` primitive both Y.Doc owners use to reach the cloud sync server.
- [Network Topology](./network-topology.md): the WAN-side picture; how Y.Doc owners (browser tabs, daemons) converge across machines via the cloud sync server.
- [Action Dispatch](./action-dispatch.md): cross-device action invocation via the Y.Doc requests mailbox; the third transport, used when an action must run on a *specific* peer rather than the local daemon.
- [Device Identity](./device-identity.md): how peers and the daemon identify themselves to the cloud sync server and to each other.
- [Security](./security.md): trust boundaries between processes, the cloud sync server, the unix socket, and the shared mirror files on disk.
- `packages/cli/src/commands/serve.ts`: the daemon entry point.
- `packages/workspace/src/daemon/sync-hub.ts`: `attachSyncHub` (daemon side of the local sync transport).
- `packages/workspace/src/client/sync-ipc.ts`: `attachSyncIpc` (script side).
- `packages/workspace/src/client/sqlite-mirror.ts`: `attachSqliteMirror` (script-side reader of `mirror.db`).
- `packages/workspace/src/client/markdown-mirror.ts`: `attachMarkdownMirror` (script-side reader of the `md/` tree).
- `packages/workspace/src/document/materializer/sqlite/`: `attachSqliteMaterializer` (writer).
- `packages/workspace/src/document/materializer/markdown/`: `attachMarkdownMaterializer` (writer).
