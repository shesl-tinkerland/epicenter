# Sync-as-peer: scripts hold a real workspace, the daemon is a sync hub

**Status**: proposal, not yet implemented
**Date**: 2026-04-29
**Author**: Braden, drafted with Claude
**Companion docs**:
- [`specs/20260429T120000-remote-workspace-is-the-action-tree.md`](./20260429T120000-remote-workspace-is-the-action-tree.md): the prior round, which collapsed the parallel remote contract into one mapped type. This spec walks the same direction one step further: it deletes the remote contract entirely.
- [`specs/20260429T004302-workspace-as-daemon-transport.md`](./20260429T004302-workspace-as-daemon-transport.md): the round that introduced the JSON-RPC transport. This spec retires that wire for workspace data.
- [`packages/workspace/docs/architecture/process-topology.md`](../packages/workspace/docs/architecture/process-topology.md): the runtime architecture this spec rewrites. The "Why two transports and not one" section is the explicit thing this spec answers differently.
- [`packages/workspace/docs/architecture/network-topology.md`](../packages/workspace/docs/architecture/network-topology.md): the sync-server view of how peers converge. The daemon was already a peer; this spec makes the daemon's local IPC look identical.
- [`.context/script-as-peer/`](../.context/script-as-peer/): the four-page exploration that motivated this spec.

---

## One sentence

Scripts hold a real workspace (real `Y.Doc`, real `attachTables`) that syncs with the daemon via Yjs over a unix socket; scripts read the daemon's incrementally-maintained materialized state (SQLite in WAL mode, markdown tree) directly from the filesystem, getting full Drizzle / raw SQL / FTS5 with zero RPC for reads. Each consumer composes by attaching exactly the resources it needs.

## The vision, stated upfront

There is no proxy. There is no `Remote<T>`. There is no JSON envelope. The script's workspace handle is **composed by attaching exactly the resources the script needs**, with two honest namespaces:

```ts
await using fuji = await openFujiPeer();

// 1. fuji.tables.X: pure local Y.Doc. CRDT writes/reads/observe/batch.
fuji.tables.entries.set({ id, url });
fuji.tables.entries.observe(rerender);
fuji.batch(() => { /* multiple writes */ });
fuji.ydoc.getText('readme').insert(0, '#');

// 2. fuji.sqlite / fuji.markdown: read-only access to the daemon's
//    materialized files. Full Drizzle, raw SQL, FTS5, file walks. No RPC.
const recent = await fuji.sqlite.drizzle
  .select().from(entries)
  .where(gt(entries.createdAt, weekAgo))
  .orderBy(desc(entries.createdAt))
  .limit(50);
const hits = await fuji.sqlite.search('entries', 'hello world');
for await (const file of fuji.markdown.list({ prefix: 'entries/' })) { ... }
```

Each namespace exists because the others can't do its job:

- `tables.X` is the CRDT (single source of truth, mutations, live observation, freshness-coherent reads).
- `sqlite` and `markdown` are the read-side (zero-RTT, full SQL/Drizzle, daemon's warm index reused via filesystem).

There is no third namespace for "dispatch a server-only action to the daemon." Server-only side effects (Stripe calls, kicking peers, reloading config) flow through one of two paths that already exist: (a) the daemon's own observer reacts to a Y.Doc state change the script wrote, or (b) a CLI command runs in the daemon's own process (e.g. `epicenter kick <peerId>`). See "Server-only side effects" below. Adding a third script-facing namespace for these turned out to be over-engineering.

**Composability lives at the per-app factory level.** `openFujiPeer()` returns the full bundle for fuji (CRDT + IPC sync + SQLite mirror + markdown mirror) because fuji's `openFujiDaemon` writes both materializer files. The factory IS the composition: a new daemon-side materializer adds a new field on the peer return type; TypeScript catches consumer breakage at call sites. There is no runtime feature flag, no string literal in the API, no optional fields. If a script genuinely wants a different shape, it bypasses the per-app factory and composes primitives directly: `openFuji()` + `attachIpcSyncClient(...)` + whichever mirrors it wants.

Three env factories per app (`browser.ts`, `daemon.ts`, `peer.ts`), one underlying type (`Fuji = ReturnType<typeof openFuji>`), differing only in attached IO handles. The script's `fuji` is structurally a peer of the browser's `fuji`. They differ in lifetime and in which `attach*` primitives carry the bytes, not in the API surface.

The daemon stops dispatching JSON envelopes. It runs a Yjs sync state machine on the unix socket using the same `@epicenter/sync` module that already powers cloud sync. The script's writes flow into the daemon as `update` messages; the daemon's `update` events flow back to subscribed peers; the daemon persists, materializes, and cloud-syncs as the single local writer to disk. The materialized state the daemon keeps warm (SQLite mirror, markdown tree) is accessible to scripts by opening the same files read-only, not by routing through the wire.

## Topology

Two diagrams. The first shows the processes and which IO each attaches. The second shows the two transports a script peer uses to talk to the daemon.

### Process roles and attachments

```
                ┌──────────────────────┐
                │  cloud sync server   │
                │  (apps/api)          │
                └──────▲────▲──────────┘
                       │ WS │ WS
       ┌───────────────┘    └──────────────────────────────┐
       │                                                   │
  ┌────┴──────────┐                       ┌────────────────┴────────────┐
  │ Browser tab   │                       │ Daemon                      │
  │               │                       │  ydoc 'fuji'                │
  │  ydoc 'fuji'  │                       │  ydoc 'tab-manager'         │
  │  ├─ IDB       │                       │  ydoc 'system' (synthetic)  │
  │  └─ Sync (WS) │                       │                             │
  └───────────────┘                       │ Per workspace, daemon attaches:
                                          │  ├─ attachSqlite (.db log)  │
                                          │  ├─ attachSync (cloud WS)   │
                                          │  ├─ attachSqliteMaterializer│
                                          │  │     ↓ writes mirror.db   │
                                          │  │       (PRAGMA WAL)       │
                                          │  ├─ attachMarkdownMaterializer
                                          │  │     ↓ writes md/ tree    │
                                          │  └─ attachIpcSyncServer           │
                                          │        ↓ on daemon.sock     │
                                          └────────────┬────────────────┘
                                                       │
                                  ┌────────────────────┬────────────────────┐
                                  │                    │                    │
                          (1) Yjs sync                                (2) shared files
                              over unix                                   on disk
                              socket                                      SQLite WAL +
                                                                          md/ tree
                                  │                                         │
                              ┌───┴─────────────────────────────────────────┴───┐
                              │  vault scripts (openFujiPeer)                   │
                              │  CLI commands (openDaemon = peer of 'system')   │
                              │                                                 │
                              │  fuji.tables.X     ← (1) local Y.Doc            │
                              │  fuji.sqlite       ← (2) read-only mirror.db    │
                              │  fuji.markdown     ← (2) read-only md/ tree     │
                              └─────────────────────────────────────────────────┘
```

Three Y.Docs hosted by the daemon (two user workspaces plus one synthetic system). The cloud WebSocket is unchanged.

### Two transports script ↔ daemon

```
                                            DAEMON                                SCRIPT
                                            ──────                                ──────
                                              │                                     │
(1) Yjs sync over daemon.sock                 │  ◀─── CRDT writes/reads ────▶      │
    binary frames, length-prefix              │       observe, awareness,           │
    MESSAGE_TYPE.{SYNC,AWARENESS}             │       Y.Text bind, batch            │
                                              │                                     │
(2) Shared filesystem (no socket)             │                                     │
    daemon writes mirror.db (WAL)             ─────► reads mirror.db { readonly }   │
    daemon writes md/ tree                    ─────► reads md/ via fs walk          │
                                                                                    │
                                              ◀───── (no return path; reads are local)
```

Transport (1) is the unix socket carrying Yjs sync (the existing `@epicenter/sync` framing). Transport (2) crosses by the filesystem, with SQLite WAL handling concurrency between the daemon writer and N script readers. There is **no third transport** for "RPC dispatch to the daemon" — server-only side effects flow through (1) as Y.Doc state the daemon's own observer reacts to, or run as daemon-internal commands invoked via `epicenter <command>` in the daemon's own process.

## Concepts glossary

This spec introduces or relies on several Yjs and IPC concepts that may not be obvious. Skim this section before reading the design; refer back as needed.

### `clientID` (Yjs)
A 53-bit positive integer per `Y.Doc` instance. Every operation is attributed in the StructStore as `(clientID, clock) -> op`, where `clock` is a per-clientID monotonic counter. This is Yjs's causality vector. State vectors (the sync handshake's diff key) index by clientID. See `clientID discipline` below for the stable-derivation requirement.

### `deviceId` (Epicenter)
A user-configured string identifying a physical or logical device (e.g., `'laptop-braden'`). Distinct from `clientID`: one device commonly hosts multiple Y.Docs (browser tab + script), each with its own clientID. Used by awareness presence and cross-device action dispatch (`peer<T>(deviceId)`), not by Yjs internals.

### State vector
A compact summary `Map<clientID, maxClock>` representing "what I have." The peer ships its state vector in STEP1; the server returns "every op not covered by your vector" in STEP2. Bigger state vector = more handshake bytes. This is why ephemeral peers with random clientIDs are expensive (the daemon's vector grows by one entry per invocation).

### STEP1 / STEP2 (Yjs sync protocol)
The two-message handshake:
- `STEP1 { stateVector }` says "this is what I have, send me what I'm missing."
- `STEP2 { update }` answers with the diff (V2-encoded).

In sync-ipc both sides do this in parallel: client and server each send their STEP1 on connect, each replies with STEP2.

### `origin` (Yjs transactions)
Every write to a `Y.Doc` carries an opaque `origin` tag, observable on `ydoc.on('updateV2', (update, origin) => ...)`. Used to break echo loops: when a peer's update is applied with `Y.applyUpdateV2(doc, bytes, sessionOrigin)`, the fanout listener filters `if (origin === sessionOrigin) return` so the originating peer doesn't receive its own write back.

**Per-session origin symbols are load-bearing on the daemon hub.** The hub multiplexes N peer sessions over one Y.Doc; each session uses `Symbol(`hub:${sessionId}`)` as its origin so the fanout filter means "don't echo to THIS peer" while still fanning to siblings. A single shared `IPC_ORIGIN` would block fanouts to all sibling peers.

### Awareness (Yjs)
A separate primitive (`y-protocols/awareness`) for ephemeral presence: cursor positions, "I'm online", typing indicators. Unlike CRDT state, awareness:
- Auto-expires when a connection drops (`removeAwarenessStates` on disconnect).
- Doesn't go in the StructStore (no causality, no permanent retention).
- Has its own broadcast lane: `MESSAGE_TYPE.AWARENESS`.

The synthetic system workspace's "connected peers" surface is Awareness, not a Y.Map, precisely because it is single-writer (daemon) and ephemeral.

### `MESSAGE_TYPE` constants (`@epicenter/sync`)
The first varint of every framed message identifies its kind:
- `SYNC` (0): contains a STEP1, STEP2, or UPDATE inside.
- `AWARENESS` (1): an awareness state update.
- `QUERY_AWARENESS` (3): "send me the current awareness states" (used by cloud sync; not used by IPC).
- `SYNC_STATUS` (100): version-tracking for "Saving..."/"Saved" UX. **Excluded from the IPC wire** (no flush primitive).
- `RPC` (101): cross-peer action dispatch. **Excluded from the IPC wire** (no IPC mailbox; cross-device RPC stays on cloud sync).

### Length-prefix framing
Unix sockets are byte streams: `data(socket, chunk)` may give you half a message or three messages glued together. The framer prepends a 4-byte little-endian length to each payload; the receiver buffers until it has a complete frame. Implemented in `sync-ipc/framing.ts`.

### `IpcChannel`
The internal duplex-channel abstraction in `sync-ipc/types.ts`. Both `bindIpcSocket` (production) and the test in-memory channel pair conform to it. Lets the server's `acceptSession` and the client's session loop be socket-agnostic and unit-testable without a real socket.

### `isEphemeral` (preamble flag)
The peer self-declares one-shot script (`true`, the default) vs long-running peer (`false`, e.g., browser tab, sidecar). Two semantic effects:
- The daemon does NOT publish ephemeral peers' presence on the system workspace's awareness (avoids flicker as scripts come and go).
- Per-peer sync state retention across reconnects is not held for ephemeral peers (currently neither side implements retention; future work).

### Wellcrafted `Result` on the wire
Wire envelopes serialize the literal `Result<T, E>` shape from wellcrafted: `{ data, error }` where `error` is either `null` (success) or a defineErrors variant with `name`, `message`, and structured fields. The discriminator is `error.name` (the variant tag), not a custom `_tag` field. The peer parses JSON and narrows on `error.name === 'NoSuchWorkspace'` to handle typed failures.

### WAL mode (SQLite)
`PRAGMA journal_mode = WAL` enables Write-Ahead Logging: the database file plus a separate `.db-wal` file allow N readers + 1 writer concurrently with snapshot isolation. Required so the script-side `attachSqliteMirror` can open the daemon's mirror file `{ readonly: true }` and run Drizzle/raw SQL/FTS5 without blocking the daemon writer.

WAL requires a local filesystem (NFS does not honor WAL coordination). On macOS/Linux local disks, this is the bread-and-butter SQLite pattern.

### Materializer vs Mirror
Two halves of the same primitive:

| Side | Primitive | Direction | Owner |
|---|---|---|---|
| Daemon | `attachSqliteMaterializer(ydoc, { db })` | Y.Doc -> SQLite | the only writer |
| Script | `attachSqliteMirror({ filePath })` | SQLite file -> script | N concurrent readers |

Same pattern for markdown: `attachMarkdownMaterializer` writes a `.md` tree; `attachMarkdownMirror` walks it.

The script's reads are local file access against a hot OS page cache, sub-millisecond. The materializer commits synchronously on each `updateV2` event (no debounce); Yjs's `transact()` provides batching at the source, so a `batch()` block of N writes produces ONE `updateV2` event with N row changes.

## The skepticism this spec is responding to

The prior spec landed `Remote<T>` as a structurally derived mapped type, replacing a hand-written `RemoteWorkspace<W>`. That was the right move within the constraint "the wire is JSON-RPC." But the constraint itself was never re-examined.

Reading the resulting code with a fresh eye:

- The depth-bounded `Remote<T>` recursion (`MaxDepth = [1,1,1,1,1,1,1,1]`) exists because TypeScript blows up walking `Y.Doc._item.parent.doc...` This is a workaround for a problem we created by walking the workspace type at compile time looking for action leaves.
- The `Function ? never` guard exists because the recursion would otherwise traverse class-instance methods. Same root cause.
- The `WireResult<R>` flattening exists because handlers can return `R | Result<R, E>` and the wire must collapse both. Same root cause.
- The `then`-masking at every `Proxy` level exists because the proxy walks paths lazily and an awaited intermediate would resolve as a thenable. Pure transport machinery.
- The runtime stubs that throw `RemoteNotSupported` for `filter` / `observe` exist because the type's filter excluded them but the runtime's `Proxy` would happily forward them.

Every one of these exists because we chose JSON-over-HTTP as the wire and then spent engineering effort making the workspace's API pretend it fits. The cut-line we celebrated as elegant ("define an action to expose; otherwise it stays local") is the scar of a transport choice, not a discovered structural property.

The deeper observation: **the local workspace and the remote workspace are not really two things.** They are one thing accessed through two costs. The browser tab and the daemon already prove this; both own a Y.Doc, both attach IO appropriate to their environment, both interact with the workspace through plain method calls. Scripts being the odd one out is an accident of how we chose to make them cheap.

## The reframe

Step back. What is the workspace, really? It is a Y.Doc with structural extensions (`attachTables`, `attachKv`, `attachEncryption`) and behavioral extensions (action methods, materializers, sync). It is not a service. It is not an API. It is a CRDT-backed object with attachable IO.

Process topology, restated honestly:

| Process | Owns a real workspace | IO it attaches |
|---|---|---|
| Browser tab | Yes | `attachIndexedDb`, `attachSync` (cloud WS) |
| Daemon | Yes | `attachSqlite`, `attachSync` (cloud WS), `attachIpcSyncServer` (local IPC) |
| Script | Yes | `attachIpcSyncClient` (local IPC) only |
| Test fixture | Yes | none, or `attachSqlite` over a tmpdir |

Every process holds a real workspace. The differences are entirely in what `attach*` calls fire. The script attaches `attachIpcSyncClient` instead of `attachSqlite + attachSync`, which means: persistence and cloud sync are *delegated to the daemon* through the IPC sync session. The script is in-memory and ephemeral; the daemon is durable and cloud-connected.

There is no second contract. There is no remote shape. The script imports `openFuji` for runtime, not just type, and the function body actually runs.

## What carries the bytes: one socket, one protocol, one mode

Today the daemon binds one unix socket at `<absDir>/.epicenter/daemon.sock` and serves Hono HTTP on it (`/ping`, `/peers`, `/list`, `/run`). The earlier draft of this spec had two modes on the new socket — "control RPC" for daemon-wide queries, "sync" for workspace peering — split by a `kind` discriminator in the preamble. That asymmetry was a smell. **Daemon-control RPC was a category I invented to preserve the shape of the existing HTTP routes, not a category that earns its keep.**

The honest design: **every connection is a sync session.** The daemon hosts user workspaces (`fuji`, `tab-manager`) plus a synthetic `system` workspace whose Y.Maps describe the daemon itself (connected peers, hosted workspaces, version). Every consumer — browser tab, CLI, vault script — is a peer of *some* workspace. The CLI is a peer of `system`. There is no second mode.

```
<absDir>/.epicenter/
└── daemon.sock     ← raw stream. Length-prefix framing. Yjs sync sessions.
```

```ts
// Daemon side. Hosts user workspaces + a system workspace.
const fuji   = openFujiDaemon({ ... });           // user workspace
const system = openSystem({ daemonState });       // synthetic; tracks peers, workspaces, version

attachIpcSyncServer({
  socket: socketPathFor(absDir),
  workspaces: [fuji, system],                     // hub multiplexes by workspace selector
});

// CLI side. Peer of 'system'.
await using daemon = await openDaemon();          // attachIpcSyncClient against 'system'
const peers = daemon.peers.getAll();              // Y.Map read, local
daemon.peers.observe(cb);                         // free: subscribe to live changes

// Script side. Peer of 'fuji'.
await using fuji = await openFujiPeer();          // attachIpcSyncClient against 'fuji'
fuji.tables.entries.observe(cb);
```

Wire framing is **u32 LE length-prefix + payload**: read 4 bytes, parse as little-endian unsigned int N, read exactly N more bytes, that is one message. ~30 lines of framing code shared between server and client. Outer message-type discrimination inside the framed payload uses the cloud convention's two relevant entries: `SYNC` and `AWARENESS`. The IPC wire deliberately omits `SYNC_STATUS` (no flush primitive in v3) and `RPC` (no IPC mailbox; cross-device peer<T> stays on cloud sync).

Hono is dropped from the daemon entirely (`hono` and `@hono/standard-validator` come out of `@epicenter/workspace`'s dependencies). The replaced surface — `/ping`, `/peers`, `/list` — wasn't a framework's worth of work; it was three operations that map cleanly onto reads/observations of the system workspace. `ping` deletes outright (a successful connect *is* the liveness signal). `peers` is `system.peers.getAll()`. `list` is `system.workspaces.getAll()`. Operations that genuinely need server-side authority (e.g. "kick a peer") become `defineMutation` instances on the system workspace, dispatched through the cross-device action mailbox the codebase already has.

## The handshake

Every connection is a sync session. The preamble is the workspace selector and auth context:

```
PEER → DAEMON (length-prefixed JSON frame):
  {
    workspace: 'fuji' | 'system' | <other>,
    deviceId: '<deviceId>',
    clientId: number,                          // mandatory; see "clientID discipline"
    isEphemeral: boolean,                      // true = one-shot script; false = long-running peer
    schemaManifest: { [tableName]: string },   // sha-256 of the union schema per table
  }
  // Note: no separate peerId. Yjs's clientId already serves both as the CRDT causality
  // token and the awareness identifier. Reconnect dedup keys on clientId. deviceId
  // is for cross-device addressing (different concern).

DAEMON → PEER (length-prefixed JSON frame, serialized Result):
  { data: { workspaceGuid, encryptionKeys?, serverClientId, daemonManifest }, error: null }
  // OR
  { data: null, error: { _tag: 'NoSuchWorkspace' | 'AuthDenied' | 'SchemaMismatch' | 'WorkspaceUnavailable', message: '...', context: {...} } }

After preamble, both sides switch to binary Yjs frames (still length-prefixed):
  PEER → DAEMON: SYNC_STEP1 with peer's state vector
  DAEMON → PEER: SYNC_STEP2 with the missing updates
  DAEMON → PEER: SYNC_STEP1 with daemon's state vector
  PEER → DAEMON: SYNC_STEP2 (usually empty for fresh peer)

Steady state: bidirectional `update` and `awareness` frames.
```

`encryptionKeys` is omitted from the preamble reply for workspaces that have no encryption (the system workspace is unencrypted because it is machine-local; user workspaces are encrypted as today).

Wire responses serialize the existing `wellcrafted` Result type directly (`{ data, error }`). No bespoke `{ ok: true }` shape. The daemon's internal `Result<T, E>` is what travels.

Trust model: the unix socket is filesystem-permissioned (mode 0600 inside a 0700 directory, established by the existing `bindOrRecover`). A process with access to write the socket has access to the daemon's data. Passing encryption keys at handshake does not lower the trust boundary.

## The system workspace

A synthetic workspace the daemon hosts alongside user workspaces. It is a real Y.Doc but unlike user workspaces it has **no** `attachEncryption` (machine-local), **no** `attachSqlite` (recomputed at startup), and **no** `attachSync` to the cloud (machine-local). It carries one `Y.Map` table and an `Awareness` instance.

```ts
const system = openSystem();
attachTables(system.ydoc, {
  workspaces: wsSchema,      // populated by config load: name, guid, _v
});
// Awareness on the system doc tracks connected peers across ALL hosted workspaces.
const systemAwareness = createAwareness(system.ydoc);
```

No `defineMutation` instances on the system workspace. Imperative daemon-internal operations (kick a peer, reload config, force a materializer rebuild) are not script-facing; they run in the daemon's own process via CLI commands (`epicenter kick <peerId>`, `epicenter reload`, `epicenter rebuild <workspace>`). See "Server-only side effects" below.

The `peers` surface is **Awareness, not a Y.Map.** This is a critical correction: connected-peer state is single-writer (the daemon), ephemeral (auto-clean on disconnect), and not a CRDT use case. Using `Y.Map` for it would mean LWW conflict resolution is dead code and manual `peers.delete(peerId)` cleanup is required on every disconnect. Awareness handles this contract automatically via `removeAwarenessStates` on session close. The CLI consumes `peers` as `awareness.getStates()`; the standard observability primitive is `awareness.on('change', cb)`.

The `workspaces` table is correctly a `Y.Map`: it is stable, config-derived, single-writer, and benefits from observability for "the daemon picked up a new workspace from the config." Action manifests are NOT cached in the table — they are recomputed on read via `describeActions(workspace)` since the workspace bundle does not change at runtime.

Why this shape is good:

- One transport, one mode, one client primitive (`attachIpcSyncClient`).
- Live observability for free (`awareness.on('change', cb)` for peers; `workspaces.observe(cb)` for hosted workspaces).
- Each surface uses the right Yjs primitive for its data shape: ephemeral state in awareness, durable single-writer metadata in Y.Map.
- The CLI and vault scripts share machinery: each is a peer of one of the daemon's hosted workspaces.

Why this isn't over-engineered:

- The system Y.Doc is small (a single Y.Map with ~5–50 entries at peak).
- It does not persist to SQLite or sync to the cloud. It is reconstructed on daemon start from the live config.
- It does not carry encryption.
- Awareness propagation is a primitive that already exists in the codebase (`y-protocols/awareness`); no new state-tracking code on the daemon side beyond the existing per-session lifecycle.

## clientID discipline

### What `clientID` is, mechanically

Yjs assigns every `Y.Doc` instance a 53-bit positive integer `clientID`. Every operation that doc emits is attributed in the StructStore as `(clientID, clock) -> operation`, where `clock` is a per-clientID monotonic counter. The pair forms Yjs's causality vector: every CRDT op carries the identity of the doc that produced it.

Two replicas converge by exchanging **state vectors**. A state vector is the compact summary `Map<clientID, maxClock>`: "I have all clocks <= N for clientID X, all clocks <= M for clientID Y, ..." The sync handshake's STEP1 ships the peer's state vector; STEP2 returns "every operation not covered by your vector." Bigger state vector = bigger handshake.

CRDT correctness depends on never reusing a `(clientID, clock)` pair for two different ops. Yjs's default is to mint a random 53-bit clientID per `new Y.Doc()`; collisions are astronomically unlikely. Every clientID that ever wrote stays in the StructStore forever (CRDT causality is unbounded).

### Why ephemeral peers create a problem

A vault script invoked once per `bun run script.ts` constructs a fresh `new Y.Doc()`, which gets a fresh random clientID. If the script writes anything, that clientID lands permanently in the StructStore. 10k invocations per week => 10k clientID entries per week in the daemon's state vector. Every new peer's cold-start sync ships the full state vector.

Browsers and the daemon don't have this problem because they're long-running processes: one Y.Doc, one clientID, for the life of the tab/process.

### The fix: derive `clientID` from the script's identity

Two invocations of the same script must reuse the same clientID. The script's logical identity (its entry-point path) is stable across runs; hash it.

```ts
// packages/workspace/src/shared/client-id.ts
export function hashClientId(path: string): number {
  const digest = createHash('sha256').update(path).digest();
  // First 8 bytes as big-endian u64, masked to 53 bits, +1.
  // 53 bits because Number.MAX_SAFE_INTEGER is 2^53 - 1; Yjs stores
  // clientIDs as JS numbers, not BigInt. +1 because clientID 0 is
  // reserved by Yjs for "no peer."
  ...
}

await using fuji = await openFujiPeer();
// openFujiPeer internally:
//   const ydoc = new Y.Doc({ guid, clientID: hashClientId(Bun.main) });
```

Two invocations of `vault/scripts/import-feed.ts` => same clientID => their writes appear to Yjs as "more clocks from the same peer" (totally fine; identical to a single peer doing all the writes in sequence). Two different scripts => different clientIDs (sha256 collision space at 53 bits >> any vault's script count). The state vector grows with *distinct mutating scripts*, not invocations.

Read-only scripts never write to the StructStore, so the choice is irrelevant for them; we still pass the hashed clientID for consistency (and for awareness identification when applicable).

This is decided, not optional. The supervisor's reconnect-dedup logic and the daemon's awareness teardown both key on clientID being stable across reconnects of the same logical peer.

### Edge case: `bun -e '<inline>'` has no stable `Bun.main`

For inline eval the entry-point path is meaningless. `hashClientId` falls back to a random clientID and logs a `warn` that this invocation will accumulate a state-vector entry. Acceptable because eval is rare; the typical workflow is `bun script.ts`.

### `clientId` vs `deviceId` (different concerns; do not conflate)

Both appear in the IPC preamble. They are not the same thing.

| | `clientId` | `deviceId` |
|---|---|---|
| Scope | per-Y.Doc instance | per machine / per logical "device" |
| Purpose | CRDT causality + state-vector keying | Cross-device addressing (`peer<T>(deviceId)`); awareness identity |
| Lifetime | persists in StructStore forever once it writes | configured by user; persisted in OS keychain or config |
| Type | 53-bit positive integer | string (e.g., `'laptop-braden'`) |
| Used by | Yjs internals, sync handshake | awareness presence; cross-device action dispatch |

Two peers with the SAME deviceId but DIFFERENT clientIds is normal: one device, two processes (e.g., the browser tab and a script, both opening their own Y.Docs). They converge through sync.

## The writer/reader split for materialized state

The daemon already pays the cost of keeping derived state warm: every Y.Doc update flows through `attachSqliteMaterializer` and `attachMarkdownMaterializer` listeners that incrementally update a SQLite mirror file and a markdown directory. A script that wants FTS5 search, Drizzle queries, or markdown file walks should not redo that work; it should read what the daemon already has.

The cleanest way to share derived state across processes is **the filesystem**, not the wire. SQLite's WAL (Write-Ahead Logging) mode is built for exactly this: one writer, many concurrent readers, MVCC snapshots. The daemon writes the mirror; scripts open the same file `{ readonly: true }`; both coexist without locks blocking. No round trips. No serialization. Full Drizzle / raw SQL / FTS5.

```
DAEMON SIDE (writers, attached on the Y.Doc)        SCRIPT SIDE (readers)
────────────────────────────────────────────        ──────────────────────
attachSqlite                                        (none: script's Y.Doc IS the data)
  ↓ writes <absDir>/.epicenter/persistence/<g>.db   

attachSqliteMaterializer (PRAGMA WAL)               attachSqliteMirror
  ↓ writes <absDir>/.epicenter/mirrors/<g>.db         ↑ opens read-only with WAL
    typed rows + FTS5 triggers                        returns: { db, drizzle, search }

attachMarkdownMaterializer                          attachMarkdownMirror
  ↓ writes <absDir>/.epicenter/markdown/<g>/**.md     ↑ exposes file walks, glob, watch
```

The persistence layer (`attachSqlite`) has no reader because the script's synced Y.Doc is the read interface for that data. Only the **materialized** views (which expose data in shapes the Y.Doc doesn't, like FTS5 indices or markdown text) need readers.

Concrete script usage:

```ts
import { eq, desc } from 'drizzle-orm';
import { entries } from '@apps/fuji/db-schema';
import { openFujiPeer } from '@apps/fuji/peer';

await using fuji = await openFujiPeer();

// Reads through the daemon's warm SQLite mirror. Full Drizzle. No RPC.
const recent = await fuji.sqlite.drizzle
  .select().from(entries)
  .where(gt(entries.createdAt, weekAgo))
  .orderBy(desc(entries.createdAt))
  .limit(50);

// FTS5 too (raw SQL when you want it):
const hits = await fuji.sqlite.search('entries', 'hello world', { limit: 50 });

// Markdown reads, daemon's materialized .md tree:
for await (const file of fuji.markdown.list({ prefix: 'entries/' })) {
  console.log(file.id, await fuji.markdown.read(file.id));
}

// Writes flow through Y.Doc (CRDT is the source of truth). Bulk
// import wrapped in fuji.batch produces one updateV2 event for the
// materializer, which commits one SQL transaction:
fuji.batch(() => {
  for (const url of inputUrls) {
    fuji.tables.entries.set({ id: crypto.randomUUID(), url });
  }
});
```

Why this is right:

- **Reuses the daemon's warm work.** No cold-start FTS index build per script.
- **Full in-memory APIs.** Drizzle's chainable query builder, raw SQL, FTS5, file walks all work because they execute in the script's process against a real SQLite handle and a real filesystem path.
- **Asymmetric by design.** Writes flow through Y.Doc (CRDT is the source of truth); reads flow through the materialized mirror (the daemon is the indexer). Each side does what it's best at.
- **Same-machine only is fine.** Cross-machine peers do not share a daemon; this entire surface is moot for them. They use cloud sync (which is unchanged).

A script that wants to be **independent of the daemon** (offline, snapshot, embedded test) can still attach its own `attachSqliteMaterializer` to its synced Y.Doc and pay the cold-start cost itself. That escape hatch stays available; it is simply not the default.

## The new `peer.ts` factory

Per-app, alongside `index.ts` (env-agnostic core) and `browser.ts` / `daemon.ts` (env factories):

```ts
// apps/fuji/src/lib/fuji/peer.ts
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { openFuji } from './index.js';
import * as schema from './db-schema.js';
import {
  attachIpcSyncClient, attachSqliteMirror, attachMarkdownMirror,
  findEpicenterDir, socketPathFor, mirrorPathFor, markdownPathFor,
  hashClientId,
} from '@epicenter/workspace';

export async function openFujiPeer(opts: {
  absDir?: string;
  clientId?: number;        // defaults to hashClientId(Bun.main)
  isEphemeral?: boolean;    // defaults to true; opt false for long-running peers
} = {}) {
  const absDir = opts.absDir ?? findEpicenterDir();
  const fuji = openFuji({ clientId: opts.clientId ?? hashClientId(Bun.main) });

  // Local Y.Doc, synced over the unix socket.
  const ipc = await attachIpcSyncClient(fuji.ydoc, {
    socket: socketPathFor(absDir),
    workspace: 'fuji',
    encryption: fuji.encryption,
    isEphemeral: opts.isEphemeral ?? true,
  });
  await ipc.whenSynced;

  // Read-only access to the daemon's materialized files.
  const sqliteMirror = attachSqliteMirror({ filePath: mirrorPathFor(absDir, fuji.ydoc.guid) });
  const markdownMirror = attachMarkdownMirror({ rootPath: markdownPathFor(absDir, fuji.ydoc.guid) });

  return {
    ...fuji,                                        // tables.X, kv.X, batch, ydoc
    ipc,
    sqlite: { ...sqliteMirror, drizzle: drizzle(sqliteMirror.db, { schema }) },
    markdown: markdownMirror,
    async [Symbol.asyncDispose]() {
      sqliteMirror[Symbol.dispose]();
      markdownMirror[Symbol.dispose]();
      await ipc.close();
      fuji[Symbol.dispose]();
    },
  };
}
```

`openFuji` itself takes an optional `clientId` so all three env factories can pass a stable id. Spread, not `Object.assign`: action methods close over `tables` from `openFuji`'s scope, not over the returned object's identity.

The daemon factory composes the same way, attaching writers instead of readers:

```ts
// apps/fuji/src/lib/fuji/daemon.ts (sketch)
export function openFujiDaemon(opts) {
  const fuji = openFuji();
  // Persistence (write-ahead log of Y.Doc updates):
  attachSqlite(fuji.ydoc, { filePath: persistencePath(opts.absDir, fuji.ydoc.guid) });
  // Cloud sync:
  attachSync(fuji.ydoc, { url: opts.cloudUrl, auth: opts.token });
  // Materialized views — daemon-side WRITERS, paired with the peer-side READERS:
  attachSqliteMaterializer(fuji.ydoc, {
    db: new Database(mirrorPathFor(opts.absDir, fuji.ydoc.guid)),
    // PRAGMA journal_mode = WAL set internally
  }).table(fuji.tables.entries, { fts: ['title', 'body'] });
  attachMarkdownMaterializer(fuji.ydoc, {
    rootPath: markdownPathFor(opts.absDir, fuji.ydoc.guid),
  }).table(fuji.tables.entries);
  // Local IPC sync hub:
  attachIpcSyncServer(fuji.ydoc, { socket: socketPathFor(opts.absDir) });
  return fuji;
}
```

This is the **honest cut-line**: `fuji.tables.X` and `fuji.kv.X` are pure CRDT (run locally, sync to daemon naturally); `fuji.sqlite` and `fuji.markdown` are read-side views of state the daemon already maintains. No redundant surfaces; no "you could call this through the wire OR locally and get the same thing" footguns. Server-only side effects (auth-tokened external APIs, kicking peers, reloading config) flow through one of two paths described in the next section.

## Server-only side effects

Some operations require the daemon's runtime context: env-var-based credentials (Stripe keys, OAuth tokens), the daemon's session map (kicking a peer), the daemon's config loader (reloading after edits). Scripts cannot run these locally. The spec deliberately does NOT expose a `fuji.daemon.X` namespace for them. Two paths exist already:

**Path A: Y.Doc-mediated request/response.** The script writes a request entry into a Y.Map; the daemon's own observer reacts; the daemon performs the side effect; writes the result back into the Y.Doc. The script can `observe` for the result if it cares. This is the same pattern as cross-device action dispatch, just over the local IPC sync.

```ts
// Script side:
const requestId = crypto.randomUUID();
fuji.tables.invoiceRequests.set({ id: requestId, entryId, status: 'pending' });

// Daemon side (in openFujiDaemon):
fuji.tables.invoiceRequests.observe(async (changedIds) => {
  for (const id of changedIds) {
    const req = fuji.tables.invoiceRequests.get(id);
    if (req.status !== 'pending') continue;
    const result = await stripe.charge({ entryId: req.entryId });
    fuji.tables.invoiceRequests.update(id, { status: 'done', result });
  }
});
```

The script-side observer can resolve a Promise on the result entry if the script wants to await. This is a small handful of lines and uses primitives the codebase already has.

**Path B: daemon-internal CLI commands.** Anything genuinely "admin" lives in the daemon's own process and is invoked via `epicenter <command>`, which connects to the daemon's stdin or signals the daemon directly:

```bash
epicenter kick <peerId>          # closes the peer's session in the daemon
epicenter reload                 # daemon re-reads epicenter.config.ts
epicenter rebuild <workspace>    # daemon's materializer.rebuild()
```

These don't need a script-facing namespace because scripts shouldn't be doing them. They are administrative; they belong on the CLI.

If a real "scripts need synchronous RPC dispatch to the daemon for X" use case shows up later, the additive option is to extend `attachIpcSyncServer` and `attachIpcSyncClient` to carry `MESSAGE_TYPE.RPC` frames (mirroring `attachSync`'s existing cross-device routing) and expose a `SyncAttachment` surface on the IPC client so `peer<T>(syncIpc, daemonDeviceId)` works. Not preemptive; only if proven necessary. The current spec deliberately keeps the IPC wire to pure Yjs sync.

## CLI as a peer of `system`

The CLI has no special protocol. It is a peer of the synthetic `system` workspace, with the same two-namespace shape:

```ts
const daemon = await openDaemon();   // wraps openSystemPeer() under the hood

// (1) tables.X: local read of the system Y.Doc
const workspaces = daemon.tables.workspaces.getAll();

// Awareness, connected peers (Awareness is on the system doc, exposed via daemon.peers):
daemon.peers.observe(snapshot => console.log('connected:', snapshot));

// The system workspace has no materializers, so daemon.sqlite / daemon.markdown
// are absent. Imperative admin operations are not exposed here; they live in
// daemon-internal CLI commands (see "Server-only side effects" above).
```

`openDaemon` is a thin wrapper for shell ergonomics; under the hood it is `openSystemPeer()`. There is no separate "daemon-control RPC" surface. `peers()`, `list()`, `ping` are not bespoke endpoints; they are reads against the system Y.Doc (or the trivial fact of a successful sync handshake, in `ping`'s case).

## What gets deleted

```
DELETE  packages/workspace/src/client/remote.ts                  (70 lines)
DELETE  packages/workspace/src/client/remote-workspace-types.ts  (89 lines)
DELETE  packages/workspace/src/client/connect-daemon.ts          (65 lines)
DELETE  packages/workspace/src/daemon/run-handler.ts             (121 lines)
DELETE  packages/workspace/src/daemon/run-errors.ts              (73 lines)
DELETE  packages/workspace/src/daemon/app.ts                     (~106 lines, the Hono app)
REMOVE  hono and @hono/standard-validator from packages/workspace/package.json
DELETE  packages/workspace/src/client/remote.test.ts
DELETE  packages/workspace/src/client/connect-daemon.test.ts
DELETE  packages/workspace/src/daemon/list-route.test.ts
                                                                 ─────────
                                                          ~524 LOC src + tests + a dep
```

`connectDaemon` has zero downstream callers in `apps/*`, `packages/cli`, `playground`, or `examples` (it was added in the current branch and only re-exported from the workspace package). The deletion is contained.

## What gets added

The four IPC transport files plus their shared types live together in
`packages/workspace/src/sync-ipc/` (a cohesive feature folder). The
mirror primitives live in `packages/workspace/src/client/`. The shared
helpers (`paths`, `client-id`) live in `packages/workspace/src/shared/`.

```
ADD  packages/workspace/src/sync-ipc/types.ts                 ~60 LOC
       IpcChannel (duplex framed-message channel), IpcPreamble
       (handshake JSON), IpcPreambleReply (handshake reply payload).
       Shared by server, client, and listener.

ADD  packages/workspace/src/sync-ipc/framing.ts               ~60 LOC
       u32 LE length-prefix codec: encodeFrame, createFrameReader.
       Used by both halves of the wire so byte-stream chunks
       reassemble into complete messages.

ADD  packages/workspace/src/sync-ipc/server.ts                ~340 LOC
       attachIpcSyncServer(ydoc, opts). Per-Y.Doc daemon-side sync
       coordinator. Multiplexes peer sessions over its one Y.Doc.
       Handles MESSAGE_TYPE.{SYNC,AWARENESS} only. Per-session origin
       symbols. Reconnect dedup by clientId.

ADD  packages/workspace/src/sync-ipc/client.ts                ~480 LOC
       attachIpcSyncClient(ydoc, opts). Peer side of the unix-socket sync.
       AbortController-driven supervisor; per-session listeners (no
       global activeChannel state). Exposes { whenSynced, status,
       observe, close, whenDisposed }. NO .rpc / .find / .peers; it
       isn't a SyncAttachment.

ADD  packages/workspace/src/sync-ipc/listener.ts              ~280 LOC
       bindIpcSocket(opts). Process-wide unix socket binder + workspace
       router. Parses each connection's preamble, replies with a
       serialized wellcrafted Result envelope, then hands the channel
       to the matching IpcSyncServer's acceptSession. Per-connection
       state lives in Bun's typed socket.data slot. Hono is NOT
       involved (no raw byte-stream surface in Hono).

ADD  packages/workspace/src/client/sqlite-mirror.ts           ~80 LOC
       attachSqliteMirror({ filePath }). Opens the daemon's mirror.db
       in { readonly: true } + PRAGMA query_only. Returns
       { db, search(table, query, opts), [Symbol.dispose] }.
       drizzle(db, { schema }) is wrapped at the per-app peer.ts layer.

ADD  packages/workspace/src/client/markdown-mirror.ts         ~40 LOC
       attachMarkdownMirror({ rootPath }). Returns
       { rootPath, list(prefix), read(id), [Symbol.dispose] }.
       Read-only file walks; no watch surface in v3 (chokidar deferred).

ADD  packages/workspace/src/shared/paths.ts                   ~40 LOC
       socketPathFor(absDir)            (already exists)
       persistencePath(absDir, guid)    (already exists)
       mirrorPathFor(absDir, guid)      NEW
       markdownPathFor(absDir, guid)    NEW

ADD  packages/workspace/src/shared/client-id.ts               ~45 LOC
       hashClientId(path: string): number. sha256 of path, masked to
       53 bits, +1. Stable across invocations of the same script so
       the daemon's state vector grows by distinct mutating scripts,
       not by invocations. See "clientID discipline" for why.

MODIFY packages/workspace/src/document/materializer/sqlite/sqlite.ts
       +1 LOC: db.exec('PRAGMA journal_mode = WAL') after the Database
       handle is opened. Idempotent if already set.

ADD  apps/{fuji,tab-manager,opensidian-e2e}/src/lib/<app>/peer.ts   ~40 LOC each
       openXxxPeer(opts?): composes attachIpcSyncClient + attachSqliteMirror
       + attachMarkdownMirror. Composable via opts.attach.

ADD  apps/{fuji,tab-manager,opensidian-e2e}/src/lib/<app>/db-schema.ts  ~30 LOC each
       Drizzle schema definitions, imported by both daemon.ts and peer.ts.

MODIFY apps/{fuji,tab-manager,opensidian-e2e}/src/lib/<app>/daemon.ts
       Add attachSqliteMaterializer + attachMarkdownMaterializer where
       the app needs them.

ADD  packages/workspace/src/client/sqlite-mirror.test.ts      ~150 LOC
ADD  packages/workspace/src/client/markdown-mirror.test.ts    ~120 LOC
ADD  packages/workspace/src/sync-ipc/server.test.ts           ~270 LOC
ADD  packages/workspace/src/sync-ipc/client.test.ts           ~250 LOC
ADD  packages/workspace/src/sync-ipc/listener.test.ts         ~140 LOC
ADD  packages/workspace/src/sync-ipc/framing.test.ts          ~70 LOC
ADD  per-app peer.test.ts × 3                                 ~150 LOC total
                                                              ─────────
                                                              ~2400 LOC src + tests
```

## What gets modified

| File | Change |
|---|---|
| `packages/workspace/src/daemon/server.ts` | `createWorkspaceServer` replaces `bindOrRecover(socketPath, absDir, app, ping)` (Hono-based) with `Bun.listen({ unix })` driving `attachIpcSyncServer`'s session handler. Hono dies entirely. The `bindOrRecover` stale-socket recovery logic survives, just wrapping `Bun.listen` instead of `Bun.serve`. |
| `packages/workspace/src/daemon/client.ts` | `DaemonClient` becomes a thin wrapper: `await openDaemon()` is `openSystemPeer()` under the hood. `peers()`, `list()`, `ping` are reads against the system Y.Doc / awareness, not bespoke RPC routes. ~80 of 238 lines remain. |
| `packages/workspace/src/document/materializer/sqlite/sqlite.ts` | One-line addition: `db.exec('PRAGMA journal_mode = WAL')` to enable concurrent readers. |
| `packages/workspace/src/index.ts` | Re-exports adjust: drop `connectDaemon`, `Remote`, `buildRemoteWorkspace`, `RpcError`. Add `attachIpcSyncServer`, `attachIpcSyncClient`, `attachSqliteMirror`, `attachMarkdownMirror`, `mirrorPathFor`, `markdownPathFor`, `openDaemon`, `hashClientId`. |

## What stays unchanged

These survive in full because their consumers are not the unix-socket wire:

- **`packages/workspace/src/shared/actions.ts`** — `defineQuery` / `defineMutation` action definitions, `walkActions`, `describeActions`, `invokeAction`, `RemoteActions`, `WrapAction`, `ActionManifest`. Used by cross-device peer<T> RPC, the AI tool bridge, and `system.describe`. None of those use the unix socket.
- **`packages/workspace/src/shared/schema-partial.ts`** — `partialUpdate`. Used by `attach-table.ts` to build the `update` action's input JSON Schema in the manifest, consumed by cross-device RPC and the AI bridge.
- **`packages/workspace/src/document/attach-table.ts`** — the action metadata on the six CRUD methods stays. That metadata is what `walkActions` discovers for `system.describe`, what `peer<T>` types target, and what the AI bridge exposes. It was never solely a unix-socket concern.
- **All `attach*` primitives** — `attachSync` (cloud), `attachSqlite`, `attachIndexedDb`, `attachEncryption`, `attachTables`, `attachKv`, `attachAwareness`, `attachBroadcastChannel`, materializers. Untouched.
- **`packages/workspace/src/rpc/peer.ts`** — cross-device peer RPC via the Y.Doc requests mailbox. Orthogonal transport.

## New invariants from cross-aspect review

Eight items the design review caught that are load-bearing enough to write down explicitly. Each one is a concrete failure mode if you don't honor it.

### Per-session origin symbols on the hub

`SYNC_ORIGIN` is a single shared symbol on the cloud transport, which works because there is one wire per Y.Doc. The hub multiplexes N peer sessions over one Y.Doc, so it MUST use **per-session origin symbols** (`Symbol(`hub:${sessionId}`)`). Each session's outbound listener filters on its OWN origin only. Sharing a single `IPC_ORIGIN` either echoes to the originator or swallows fanouts to siblings.

Origins on the daemon-side Y.Doc:
- `SYNC_ORIGIN` — used by `attachSync` for cloud-applied updates (unchanged)
- `Symbol(`hub:${sessionId}`)` — per-session, used when applying inbound peer updates
- `attachSqlite` — does not need its own origin; persists every update (it's a sink, not a wire)

### Reconnect supervisor in `attachIpcSyncClient`

The unix socket can break. `attachIpcSyncClient` must run an exponential-backoff supervisor mirroring `attachSync`'s `runLoop` (minus the auth path). On reconnect, run a fresh `STEP1`; Yjs's state-vector handshake is the resync queue. No application-level write queue is needed.

### Reconnect dedup on the daemon

Same `clientId` reconnecting MUST kick the prior session before announcing the new one. Without this: reconnect storm bug (automerge-repo has open issues for exactly this). On a new connection with a `clientId` that matches an existing session, the daemon disconnects the old session first, removes its awareness state, then accepts the new connection.

### Schema manifest exchange in the handshake

In the preamble, the daemon advertises a fingerprint per table (the union of accepted schema versions). The peer compares against its local manifest. If the peer's accepted-version-set is a strict subset of the daemon's (peer can't parse what daemon will send), the daemon rejects with `SchemaMismatch`. The reverse case is forward-compat and accepted. Today's silent `ValidationFailed` drop on stale-schema reads becomes a typed handshake-time refusal.

### Per-workspace supervision in the daemon

Each hosted workspace is supervised independently. A workspace whose `whenLoaded` rejects enters a `failed` phase and refuses peer connections with `WorkspaceUnavailable`; other workspaces continue serving. The `system.workspaces` Y.Map exposes per-workspace health alongside metadata.

### `isEphemeral` flag in the preamble

Stolen from automerge-repo. Peers self-declare in the handshake whether they are ephemeral (one-shot script, default) or durable (long-running, e.g. opted-in script, daemon, browser tab). The daemon uses this to decide:
- Whether to publish the peer's awareness onto the system doc (durable peers visible in `daemon.peers.observe(cb)`; ephemeral peers omitted to avoid flicker)
- Whether to retain per-peer sync state across reconnects (ephemeral peers get fresh state every connect)

Default for `openFujiPeer`: `isEphemeral: true`. Overridable via `openFujiPeer({ isEphemeral: false, awareness: true })` for long-running consumers.

### Stable `clientId` is mandatory for ephemeral peers

Not optional. Yjs's `clientId` is permanent in the StructStore for any peer that writes; ephemeral peers with random `clientId`s would accumulate one entry per script invocation in the daemon's state vector. `openFujiPeer` derives a default `clientId` via `hashClientId(Bun.main)` so two invocations of the same script reuse the same id. The state vector grows by the count of distinct mutating scripts, not invocations.

For `bun -e '<inline code>'` evals where `Bun.main` is not a stable file path, fall back to a random `clientId` and log a `warn` that this invocation will accumulate state-vector entries. Acceptable because eval is rare; the typical workflow is `bun script.ts`.

### Action manifest is recomputed on read

The `system.workspaces` Y.Map carries `{ id, name, guid, _v }` — the stable identity. Action manifests are NOT cached in the Y.Map; they are computed on-demand via `describeActions(workspace)` when a CLI peer reads them. The workspace bundle is constructed once at daemon startup; recomputing the manifest is a cheap object walk and avoids cache-invalidation bugs.

## Decided questions

1. **Encryption keys cross at handshake.** Scripts hold them in-memory, never persisted. The unix-socket trust boundary is filesystem permissions (already mode 0600 socket inside 0700 directory). This does not lower security relative to today: the script already sends plaintext input over that same socket via `/run`. Keys-vs-plaintext is a wash on a single-user machine.

2. **Scripts have stable clientIDs by default.** `openFujiPeer` derives the clientID from `Bun.main` via a stable hash unless overridden. State vector grows with the count of distinct scripts that mutate, not invocations. (See "clientID discipline" above.)

3. **No retroactive clientID GC.** Yjs causality is unbounded; we accept the bounded growth from stable-clientID discipline. A future operational concern (years-deep daemons with hundreds of scripts) gets addressed by snapshot-and-reload, not by changing this protocol.

4. **One unix socket, one mode, one protocol.** `daemon.sock` is the only socket. Every connection is a Yjs sync session against one of the daemon's hosted workspaces (selected by the preamble's `workspace` field). There is no separate "control" mode; daemon-wide queries (peers, hosted workspaces) are reads against a synthetic `system` workspace the daemon hosts alongside user workspaces. Hono is dropped from the daemon entirely; `hono` and `@hono/standard-validator` come out of the workspace package's dependencies.

5. **Length-prefix framing.** `u32 LE length` + `payload`. Bun's `Bun.listen({ unix })` and `Bun.connect({ unix })` give byte-oriented streams (SOCK_STREAM); the preamble JSON and Yjs sync frames are both message-oriented. Length prefix is the simplest universal answer (~30 lines, shared by server and client). Outer message-type byte (already in `@epicenter/sync`) discriminates `SYNC` vs `AWARENESS` inside the framed payload. The IPC wire omits `SYNC_STATUS` (no flush in v3) and `RPC` (no IPC mailbox).

6. **Wire responses serialize the existing `wellcrafted` Result type.** `{ data, error }` shape, not a bespoke `{ ok: true }` envelope. No translation layer between the daemon's internal `Result<T, E>` and what travels.

7. **The daemon hosts a `system` synthetic workspace.** Used by the CLI and any other consumer that wants daemon-wide observability. It carries peers (Awareness), hosted workspaces (Y.Map), version, and any imperative `defineMutation` instances ("kick this peer", "reload config"). It is unencrypted, not persisted, not cloud-synced. Reconstructed on daemon start.

8. **`attachIpcSyncClient` blocks on first-sync by default.** Returns a handle whose construction awaits `whenSynced` (one round trip on a fresh peer). Scripts can opt out with `awaitFirstSync: false` for advanced use cases where the script wants to race or short-circuit.

9. **The daemon does not decrypt on behalf of peers.** Y.Doc stores ciphertext; sync ships ciphertext; peers decrypt locally with the keys received at handshake. Symmetric with how the browser tab works against the cloud sync server today.

10. **No streaming RPC for daemon-control.** `peers()` is a snapshot, `list()` is a snapshot, `ping()` is just a successful sync handshake. If a future need arises (presence subscriptions outside Yjs awareness), it gets its own mechanism, not a generic streaming dispatcher.

11. **`peer.ts` is the chosen filename for the script-side env factory.** "Script" describes one use case; "peer" describes what the thing is (an ephemeral Yjs peer of the daemon). A Tauri sidecar, a long-running test harness, or a server-side renderer would all use this same factory.

12. **Table CRUD methods stay defined as actions.** Independent of this spec; serves cross-device RPC and the AI bridge. Confirms that the prior spec's work to define them as actions was correct for reasons outside the unix-socket transport.

13. **Materialized state crosses by filesystem, not by RPC.** The daemon writes the SQLite mirror in WAL mode and the markdown tree to flat files. Scripts open the same files read-only via `attachSqliteMirror` / `attachMarkdownMirror`. Reads are local and free; the daemon's incremental indexing work is reused. Writes still flow through Y.Doc; the mirror is a read-side cache, not a coherent write surface.

14. **The script's workspace handle has two honest namespaces.** `tables.X` for pure CRDT (local Y.Doc, freshness-coherent), `sqlite` / `markdown` for materialized reads (shared files via WAL or filesystem). Each surface uses the right primitive for its job; no namespace is reachable two ways. Server-only side effects use Y.Doc-mediated request entries (Path A) or daemon-internal CLI commands (Path B); they are not script-facing namespaces.

15. **Per-app factories own composition; no runtime feature flag.** `openFujiPeer()` always returns the full bundle (CRDT + IPC sync + SQLite mirror + markdown mirror) because fuji's `openFujiDaemon` writes both materializer files. The factory IS the composition. No `attach: [...]` option, no string literals, no optional fields on the return type. Scripts wanting a different shape compose primitives directly (`openFuji()` + `attachIpcSyncClient(...)`).

16. **Materializer commits synchronously, no debouncing.** `attachSqliteMaterializer` reacts to the daemon Y.Doc's `updateV2` event by committing changed rows to SQLite **in the same tick**, not on a debounce timer. Yjs's `transact()` already provides batching: a 1000-write loop wrapped in `fuji.batch(() => {...})` produces ONE `updateV2` event with 1000 row changes inside, which the materializer commits as ONE SQL transaction. The natural batching unit is the Yjs transaction, not a wall-clock window. Consequence: the SQLite mirror is coherent with the daemon's Y.Doc within microseconds of the daemon applying an update; the only remaining lag for a script reading SQLite is the IPC RTT for the daemon to RECEIVE the script's update (sub-millisecond on local IPC). Spike before commit 7: confirm SQLite throughput is fine for a realistic 10k-bulk-import workload via `fuji.batch`.

17. **No RPC, no `SYNC_STATUS` over the IPC socket.** The unix socket carries pure Yjs sync only (`SYNC`, `AWARENESS`). No `MESSAGE_TYPE.RPC` frames (no IPC mailbox); no `MESSAGE_TYPE.SYNC_STATUS` frames (no flush primitive). No `peer<T>(syncIpc, deviceId)` proxy; no `fuji.daemon.X` namespace; no `fuji.flush()` method. The cross-device peer RPC mailbox in `attachSync` (cloud) is unchanged: `peer<T>(workspace.sync, 'phone')` works the same way it does today. For local server-only effects, scripts use Y.Map request entries (Path A) or daemon-internal CLI commands (Path B); for cross-device action invocation, scripts use cloud `peer<T>` as today. For "did my write land?", scripts read from `fuji.tables.X.get(id)` (the local Y.Doc, synchronously coherent with own writes). One form of RPC remains in the system (cloud-side, unchanged); the IPC socket has none.

18. **No `flush()` primitive in v3.** Production scripts don't need read-after-write through SQLite (write-and-exit is the dominant pattern; the next invocation reads up-to-date state). If a real demand emerges later, flush is strictly additive: ~65 LOC for a flush controller plus restoring `MESSAGE_TYPE.SYNC_STATUS` to the IPC wire. No breaking change to v3 consumers.

## Implementation plan

Nine commits, in order. Each commit compiles and passes tests independently. Steps 1-6 are additive (no deletions). Step 7 is the cliff. Steps 8-9 are validation.

### 1. Add `attachIpcSyncServer` (daemon side)

- New: `packages/workspace/src/daemon/sync-hub.ts` exposing `attachIpcSyncServer(ydoc, opts)`.
- Listens for new connections on the socket; for each, reads the JSON preamble (`{ workspace, deviceId, clientId, isEphemeral, schemaManifest }`), routes to the sync-session handler.
- Runs the sync state machine using `@epicenter/sync`'s existing exports (`encodeSyncStep1`, `encodeSyncUpdate`, `handleSyncPayload`).
- Multiplexes message types via the existing outer-type byte: `SYNC`, `AWARENESS`. **No `RPC` frames** (no IPC mailbox) and **no `SYNC_STATUS` frames** (no flush primitive in v3). The cross-device peer RPC mailbox in `attachSync` is unchanged on cloud sync.
- Tracks connected sessions in a `Map<sessionId, SessionState>`; uses `awarenessProtocol.removeAwarenessStates` on disconnect.
- Per-session origin symbols (`Symbol(`hub:${sessionId}`)`) so outbound listeners filter their own origin.
- Reconnect dedup: same `clientId` reconnecting kicks the prior session.
- Returns `{ peers(): SessionSnapshot[]; close(): Promise<void>; whenDisposed }`.
- Tests: a unit test that attaches a fake socket pair, drives a SyncStep1 → SyncStep2 exchange, asserts state convergence.
- No callers yet; daemon still binds the existing Hono app.

### 2. Add `attachIpcSyncClient` (peer side)

- New: `packages/workspace/src/client/sync-ipc.ts` exposing `attachIpcSyncClient(ydoc, opts)`.
- Connects to the socket via `Bun.connect({ unix })`; sends the preamble; awaits the preamble reply (with encryption keys).
- Calls `opts.encryption.applyKeys(keys)` to seed the script's keyring before any sync frame is processed.
- Drives the peer side of the sync state machine using the same `@epicenter/sync` exports. **No SyncAttachment surface**; the IPC client is not a `peer<T>` target. Cross-device action dispatch stays on cloud sync.
- Reconnect supervisor: exponential backoff mirroring `attachSync`'s `runLoop`. On reconnect, fresh `STEP1`.
- Returns `{ whenSynced; status; observe; close; whenDisposed }`. No `flush()` (no `SYNC_STATUS` on the wire).
- Tests: fake socket pair drives SyncStep1/Step2 round trip; reconnect recovers; awareness exchange works.

### 3. Wire `attachIpcSyncServer` into `createWorkspaceServer`; drop Hono; add WAL pragma

- File: `packages/workspace/src/daemon/server.ts`.
- Replace the existing `bindOrRecover(socketPath, absDir, app, ping)` call (Hono-based) with `Bun.listen({ unix: socketPathFor(absDir), socket: { data, open, close, error } })`.
- The `data` handler frames bytes via the shared length-prefix module and dispatches to `attachIpcSyncServer`'s session handler. **No `kind` discriminator. No second mode.** The preamble's `workspace` selector does all routing; `peers` and `list` are reads against the synthetic `system` workspace, not bespoke endpoints.
- Delete `packages/workspace/src/daemon/app.ts` (the Hono app), `packages/workspace/src/daemon/build-app.ts` if present, and the `hono` + `@hono/standard-validator` entries from `packages/workspace/package.json`.
- One-line addition to `packages/workspace/src/document/materializer/sqlite/sqlite.ts`: `db.exec('PRAGMA journal_mode = WAL')` after the Database handle is opened. Idempotent if already set; required so script-side `attachSqliteMirror` can open the same file concurrently.
- The `bindOrRecover` stale-socket recovery logic survives, just wrapping `Bun.listen` instead of `Bun.serve`.
- Spin up the synthetic `system` workspace at server startup (reconstructed from live config; not persisted).
- Tests: a connection that sends a `system` preamble and reads `system.workspaces.getAll()` returns the configured workspaces.

### 4. Add `attachSqliteMirror` and `attachMarkdownMirror` (peer side, read-only)

- New: `packages/workspace/src/client/sqlite-mirror.ts`. Opens `<filePath>` with `{ readonly: true }`; runs `PRAGMA query_only`. Returns `{ db, search(table, query, opts), [Symbol.dispose]() }`. The `search` helper wraps the same FTS5 SELECT used by `attachSqliteMaterializer.search` so the surface is symmetric across writer and reader.
- New: `packages/workspace/src/client/markdown-mirror.ts`. Returns `{ rootPath, list(prefix?), read(id), [Symbol.dispose]() }`. `list` and `read` are flat fs walks. No `watch` surface in v3 (chokidar deferred to v4 if a real consumer needs it).
- New: `packages/workspace/src/shared/paths.ts` adds `mirrorPathFor(absDir, guid)` and `markdownPathFor(absDir, guid)` helpers (alongside the existing `socketPathFor`).
- Tests: hand-write a SQLite file via `attachSqliteMaterializer` (with WAL), open it with `attachSqliteMirror` from a sibling process, assert FTS5 query returns the right rows. Same for markdown: write tree, open mirror, assert `list` and `read` work.

### 5. Add `peer.ts` env factory per app + per-app `db-schema.ts`

- New: `apps/{fuji,tab-manager,opensidian-e2e}/src/lib/<app>/peer.ts`.
- Each exports `openXxxPeer(opts?)` composing `openXxx()` + `attachIpcSyncClient` + (optional) `attachSqliteMirror` + (optional) `attachMarkdownMirror`. Returned bundle has the two honest namespaces: `tables.X` (CRDT) and `sqlite` / `markdown` (materialized reads). The `attach` option lets scripts opt into just what they need.
- New: `apps/<app>/src/lib/<app>/db-schema.ts` shared between `daemon.ts` and `peer.ts`. Drizzle schema definitions; single source of column types.
- Each derives a default `clientId` from `Bun.main` via the shared `hashClientId(path: string): number` utility (already added in step 1).
- Tests: each app's `peer.test.ts` smoke-tests construction against an in-process `attachIpcSyncServer` + tmpdir socket + tmpdir mirror file. Asserts: tables CRUD works locally; `sqlite.search(...)` against the warm mirror returns the right rows; `sqlite.drizzle.select()...` returns typed rows.

### 6. Migrate `Object.assign` to spread across env factories

- Cleanup pass. Affects `apps/*/src/lib/*/browser.ts`, the new `peer.ts` files, and any `vault/epicenter.config.ts` boot wrappers (`bootFuji`, `bootTabManager`).
- Pure refactor; no behavior change. Type tests confirm equivalence.

### 7. Delete the JSON-RPC transport (the cliff)

- Delete `client/remote.ts`, `client/remote-workspace-types.ts`, `client/connect-daemon.ts`, `daemon/run-handler.ts`, `daemon/run-errors.ts`, plus their test files.
- Shrink `daemon/client.ts`: `DaemonClient` becomes `openDaemon()` returning `openSystemPeer()` under the hood. Methods: `peers` (awareness snapshot), `list` (system.workspaces read), `ping` (no-op; successful sync handshake is liveness). Drop `.run()`, `RunInput`, `ListInput`, `RpcError`. ~80 of 238 lines remain.
- Update `packages/workspace/src/index.ts` re-exports: drop `connectDaemon`, `Remote`, `buildRemoteWorkspace`, `RpcError`. Add `attachIpcSyncServer`, `attachIpcSyncClient`, `attachSqliteMirror`, `attachMarkdownMirror`, `mirrorPathFor`, `markdownPathFor`, `openDaemon`, `hashClientId`.
- Update `packages/cli/src/commands/run.ts` and `packages/cli/src/commands/list.ts`: rewrite to use `openSystemPeer()` (for `list`) or `openXxxPeer(...)` (for `run`). **Decision pending in this commit**: keep `epicenter run` for shell ergonomics, opening an ephemeral peer per invocation; or delete in favor of direct `bun run script.ts`. Default: keep.
- All workspace tests pass. CLI tests adjusted for the new transport.

### 8. Documentation pass

- Rewrite `packages/workspace/docs/architecture/process-topology.md` to describe the two-namespace + writer/reader-split model.
- Update `packages/workspace/README.md` (Multi-Device Sync Topology and Client vs Server sections) and `packages/workspace/docs/architecture/action-dispatch.md` (cross-references).
- Update `packages/workspace/CLAUDE.md` and `apps/*/CLAUDE.md` to reference the new factories.
- Add `peer.ts` and `db-schema.ts` rows to the `workspace-app-layout` skill description (the three-file pattern grows to five for apps with a daemon).

### 9. Operational sanity checks

- Hand-test the three honest production patterns from a vault script:
  ```ts
  // Pattern 1: bulk import (write-and-exit; daemon materializes after).
  await using fuji = await openFujiPeer();
  fuji.batch(() => {
    for (const url of inputUrls) {
      fuji.tables.entries.set({ id: crypto.randomUUID(), url });
    }
  });
  // Script exits. Next invocation reads the up-to-date state.
  ```
  ```ts
  // Pattern 2: query and report (pure read; no writes).
  await using fuji = await openFujiPeer();
  const recent = await fuji.sqlite.drizzle
    .select().from(entries)
    .orderBy(desc(entries.createdAt))
    .limit(50);
  console.log(recent);
  ```
  ```ts
  // Pattern 3: observe and react (long-lived; awareness off).
  await using fuji = await openFujiPeer();
  fuji.tables.entries.observe(ids => console.log('changed:', ids));
  fuji.ydoc.getText('readme').observe(() => console.log('readme edited'));
  await new Promise(() => {});  // park
  ```
  Verify each pattern: writes from pattern 1 appear in the daemon's materializer output (mirror.db), the daemon's SQLite blob log, and the cloud sync server. Pattern 2's read latency stays sub-50ms for 10k mirror rows. Pattern 3's observers fire when other peers edit.
- Performance check: measure cold-start latency of `openFujiPeer` against a daemon with 10k entries loaded. Target: `<100ms` wall-clock from `openFujiPeer()` to `whenSynced` resolved. Mirror open is essentially free (file open + PRAGMA). If actual is significantly higher, profile encode/apply path before commit 7.
- Multi-script soak: invoke 1000 ephemeral scripts that each write one row; verify daemon state-vector growth matches "one entry per distinct script identity," not "one per invocation."
- Concurrency soak: run 10 long-running scripts each issuing 100 random `sqlite.search(...)` queries against the mirror while the daemon writes 100 new rows. Verify no SQLITE_BUSY, no read errors, all queries complete.

## Validation

After step 9:

- `bun run typecheck` and `bun test` pass across `packages/workspace`, `packages/cli`, `apps/fuji`, `apps/tab-manager`, `playground/opensidian-e2e`.
- `grep -r 'connectDaemon\|Remote<\|buildRemoteWorkspace' --include='*.ts'` returns zero hits outside this spec and the deletion-commit message.
- A vault script can bind a `Y.Text` to a TUI text editor, observe live changes from the browser tab, and exit cleanly. This is the use case that motivated the spec; if it does not work, the spec failed.
- A vault script can call `fuji.sqlite.drizzle.select().from(entries).where(...)` and get results without any RPC round trip. This is the writer/reader-split test; if it does not work, option 4 failed.
- Daemon log shows `attachIpcSyncServer` accepting and disposing peer sessions cleanly with no leaked clientIDs in awareness state after disconnect.
- 10 concurrent script readers + the daemon writer survive a 1000-write soak with zero `SQLITE_BUSY`.

## Why this is worth doing

This is **not a code-reduction refactor**. The honest LOC math:

```
DELETIONS                                              ADDITIONS
─────────                                              ─────────
client/remote.ts                       70             daemon/sync-hub.ts                ~120
client/remote-workspace-types.ts       89             client/sync-ipc.ts                 ~90
client/connect-daemon.ts               65             client/sqlite-mirror.ts            ~80
daemon/run-handler.ts                 121             client/markdown-mirror.ts          ~60
daemon/run-errors.ts                   73             shared/ipc-framing.ts              ~30
daemon/app.ts (Hono)                 ~106             shared/client-id.ts                ~10
client/remote.test.ts                ~150             shared/paths.ts (additions)        ~20
client/connect-daemon.test.ts        ~100             3 × peer.ts (apps)                 ~120
daemon/list-route.test.ts            ~120             3 × db-schema.ts (apps)             ~90
                                                      server.ts sync-socket bind          ~30
                                                      materializer WAL pragma              ~1
                                                      sync-hub.test.ts                   ~120
                                                      sync-ipc.test.ts                   ~120
                                                      sqlite-mirror.test.ts              ~150
                                                      markdown-mirror.test.ts             ~80
                                                      peer.test.ts × 3                   ~150
                                    ─────                                              ─────
                                     ~894                                              ~1271

Net LOC: roughly +377. Slightly positive. The IPC RPC plumbing (~140 LOC + tests)
and the markdown watcher (~40 LOC + tests) came out as deliberate simplifications.
```

Two deps come out (`hono`, `@hono/standard-validator`); no new deps go into `@epicenter/workspace`. `drizzle-orm` may appear in consumer `apps/*/package.json` for the per-app `db-schema.ts` and the `peer.ts` Drizzle wrapper, but it stays out of the workspace package itself.

The win is not LOC. The win is in four dimensions:

1. **Concept count.** The depth-bounded `Remote<T>` (one of the gnarliest types in the codebase), the recursive `Proxy` walker with `then`-masking, the `WireResult<R>` flattening, the `RpcError` taxonomy, the "is it on the wire?" question all go away. Two parallel models ("the workspace" and "the remote workspace") collapse into one. New code added is mostly boilerplate (length-prefix framing, handshake JSON shapes, file-open wrappers); nothing in it requires the kind of careful TypeScript surgery `Remote<T>` did.

2. **Capability.** Use cases that were impossible become free:
   - Binding a `Y.Text` in a script (motivating use case).
   - Subscribing to live changes pushed by other peers.
   - Closure-based filters without round-tripping all rows.
   - Atomic multi-write batches via `batch(() => {...})`.
   - **Drizzle ORM and raw SQL against the daemon's warm SQLite mirror.** No RPC, no query manifest, no JSON serialization.
   - **FTS5 against the warm index.** Zero cold-start.
   - **Markdown file walks against the daemon's materialized tree.**

3. **Conceptual unity.** The script's API matches the browser tab's where it can (CRDT operations) and is honestly different where it must be (materialized reads via filesystem). Two namespaces, two honest semantics. No "the remote API" third surface to learn.

4. **Cost honesty.** The proxy approach charged for everything (every read crossed JSON), but its cost was hidden in the proxy's surface area. The new design exposes its cost directly: pure CRDT is local (free), materialized reads are local file access (free, after the daemon's incremental work). You can see what each call will cost just by looking at which namespace it lives on.

If you do not need the new capabilities, the JSON-RPC transport we just shipped is fine. The honest framing: this spec costs more lines than the proxy version and earns dramatically more capability plus conceptual simplicity, not code reduction. If "we want scripts to be real CRDT consumers and to read materialized state without RPC" is the goal, this spec pays for that. If only the latter half matters, options 1 or 3 from the design conversation would also work; we picked option 4 because it is the only design that doesn't redo the daemon's incremental work.

## What this is not

- **Not a deletion of `defineQuery` / `defineMutation`.** Those stay for cross-device peer RPC and the AI bridge. Table CRUD methods stay defined as actions for the same reason. This spec retires the bespoke JSON-RPC `/run` use of those actions and does NOT add a script-facing local-RPC namespace to replace it.
- **Not a change to cloud sync.** `attachSync` (the WebSocket variant) is unchanged. Cloud topology, encryption, and the requests-mailbox action dispatch are all untouched.
- **Not a change to how the daemon is started.** `epicenter serve` is unchanged. The daemon's lifecycle, signal handling, metadata, and config loading all survive.
- **Not a soft migration.** The JSON-RPC transport deletes in commit 7, all at once. Pre-1.0 internal monorepo, three known consumers, no external users; same hard-cut posture as the prior spec.
- **Not a write path through `fuji.sqlite`.** The mirror is read-only on the script side. All writes flow through `fuji.tables.X` (CRDT). The materialized SQLite is a read-side cache, not a coherent write surface.
- **Not a script-facing daemon-RPC namespace.** Earlier drafts proposed `fuji.daemon.X` as a typed mailbox proxy for daemon-only side effects. Dropped in favor of composability: server-only effects flow through Y.Doc state changes (Path A) or daemon-internal CLI commands (Path B), per "Server-only side effects."

## Open questions for review

The earlier questions either resolved or got promoted to invariants. The remaining ones, plus new questions raised by the writer/reader split:

### Resolved

- ~~CLI `run` UX~~: `epicenter run` opens an ephemeral peer of the target workspace, invokes the action method directly. Cross-device dispatch (`--peer`) still uses `peer<T>()` over cloud sync. Decided.
- ~~`/list` survival~~: replaced by `system.workspaces` Y.Map + on-read `describeActions`. CLI peer of `system` reads them.
- ~~Awareness on the script side~~: promoted to invariant (`isEphemeral: true` default, awareness off unless opted in).
- ~~Two modes on the unix socket~~: collapsed to one. Every connection is a sync session; `system` is a synthetic workspace, not a separate protocol.
- ~~Action mailbox routing for a script-facing `fuji.daemon.X` namespace~~: dropped. The namespace itself is gone in favor of composability; server-only side effects use Y.Doc-mediated request entries (Path A) or daemon-internal CLI commands (Path B). The cross-device peer RPC mailbox in `attachSync` is unchanged.
- ~~`KEYRING_UPDATE` frame semantics~~: defer. Long-running peers are not a real workload yet; rotation is yearly-ish. Ephemeral peers reconnect every invocation and pick up keys fresh. We accept "ValidationFailed until reconnect" for the rare long-running peer case. Additive to add the push frame later.
- ~~Awareness payload shape~~: lock to `{ clientId, deviceId, workspace, connectedAt }` only. No `processInfo`, no extensible `meta` slot. Long-running peers are rare; we don't need the richness yet. Additive to extend later.
- ~~`epicenter run` deletion vs survival~~: keep. ~30 LOC of CLI plumbing on top of `openFujiPeer()`. Pays for itself in shell ergonomics and tab completion.
- ~~Embedded CLI use case~~: defer to a future spec. Consumers import the full workspace package.
- ~~Hot-reload of `epicenter.config.ts`~~: restart-only. Not in scope; the dev workflow already involves editing a TS file at the terminal.
- ~~Multiple-daemons-same-machine convergence~~: accept current behavior (B). Cloud sync handles convergence between two daemons sharing a workspace ID; awareness shows them as same-`deviceId` siblings; `peer<T>` resolution picks lowest `clientId`. If a real complaint emerges, add `absDir` to awareness payload for disambiguation; additive.
- ~~Failed-workspace recovery~~: stay-failed-until-restart. Failed hydration is rare; auto-retry can mask real bugs; manual recovery is its own design concern.
- ~~Mirror staleness contract~~: principled rule documented (read freshness from `fuji.tables.X.get(id)`, not from `fuji.sqlite`); no `flush()` primitive in v3.
- ~~`flush()` primitive~~: dropped. Production scripts overwhelmingly write-and-exit; the next invocation reads up-to-date state. The contrived "tag-then-immediately-query-via-SQLite" case can use `await Bun.sleep(50)` if it ever shows up. If real demand emerges, flush is strictly additive (~65 LOC + restoring `MESSAGE_TYPE.SYNC_STATUS` to the IPC wire).
- ~~Materializer debounce~~: dropped. `attachSqliteMaterializer` commits synchronously on each `updateV2` event. Yjs's `transact()` already provides batching at the Y.Doc layer.
- ~~Script attaches its own materializer~~: supported but discouraged. JSDoc warning on `attachSqliteMaterializer` notes the cold-start cost and that the file path must NOT collide with the daemon's mirror.
- ~~Mirror schema versioning~~: skip. Vault is built from the same commit as the daemon. Published-consumer version check is deferred until there's a published consumer.
- ~~chokidar / `attachMarkdownMirror.watch`~~: skip. Ship `list` and `read` only in v3. Add `watch` later if a real consumer wants it.
- ~~Mirror file lifecycle on daemon restart~~: no retry policy in the mirror primitive. Document the contract: scripts that survive a daemon restart catch `SQLITE_BUSY` themselves with a small try/catch.

### Still open (decisions remaining)

1. **Cold-start performance target.** Original target: `<50ms wall-clock from openFujiPeer() to whenSynced` for 10k entries. Verbal alignment from review: a longer opening time is acceptable; aim `<100ms` for 10k entries, `<500ms` for 100k. Spike step 1+2 on real fuji data before commit 7 to confirm. If it blows the budget, profile encode/apply path before shipping.

2. **Synchronous-materializer throughput spike.** With debounce removed, an unbatched 10k-write loop becomes 10k SQL transactions (vs 1 with debounce). Production scripts that loop should wrap in `fuji.batch(() => {...})`, which collapses to one `updateV2` event and one SQL transaction; this is the documented pattern. Spike before commit 7: confirm `fuji.batch(() => for-10k)` runs in <500ms wall-clock. Also measure the unbatched failure mode (no `batch()` wrapper) so we know how bad the cost is when scripts forget. If unbatched is catastrophic (>10s for 10k), reconsider auto-batching at the materializer layer; if it's just slow (~1-5s), keep the current contract and lean on documentation.
