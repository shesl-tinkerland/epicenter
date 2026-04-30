# Daemon as materializer worker; scripts sync direct to cloud

**Status:** Draft
**Date:** 2026-04-29
**Author:** AI-assisted (Braden + Claude)
**Branch:** workspace-as-daemon-transport-v2

**Supersedes:**
- `20260429T230000-sync-as-peer-transport.md` (FULLY: drops the IPC Yjs-sync transport entirely)
- `20260429T004302-workspace-as-daemon-transport.md` (PARTIALLY: daemon module location, `connectDaemon` typed RPC, per-workspace `.epicenter/` layout all stay; the "scripts as IPC peers over a Yjs unix-socket sync wire" assumption goes)

**Still valid (orthogonal):**
- `20260427T010000-supervisor-redesign.md` (cloud-sync supervisor decomposition; applies to all peers since cloud sync is now THE wire)
- `20260427T020000-supervisor-redesign-step-1-abortsignal.md`
- `20260427T120000-workspace-sync-failed-phase.md`

## One-sentence thesis

The daemon's load-bearing roles are **single-writer for persistence** and **materializer side-effects**, not "sync hub for local peers"; collapsing the IPC sync transport in favor of "scripts open their own cloud WS and read the daemon's persistence file for warm hydrate" deletes ~4,500 lines of recently-shipped IPC machinery without losing any capability that one-shot scripts or long-lived workers need.

## Why this exists

The original framing in `20260429T230000-sync-as-peer-transport.md` and `docs/articles/20260429T235000-the-daemon-isnt-accidental.md` listed four reasons to keep a local IPC sync wire:

1. SQLite is single-writer.
2. Cloud WebSocket fan-out.
3. Cold-start hydrate.
4. clientID accumulation.

(1) and (2) are real. (3) and (4) are not load-bearing:

- **Cold-start hydrate.** A cold script paying `Y.applyUpdate` of the full state pays the same cost whether bytes come from local SQLite or from a daemon over unix socket; the apply dominates either way. The daemon helps long-lived peers and helps any peer that already has its own persistence (small state-vector diff over IPC), but a *fresh* script with no persistence sees no cold-start speedup from talking to a daemon vs. talking to the cloud.
- **clientID accumulation.** Solved peer-side by `hashClientId(Bun.main)` (see `packages/workspace/src/shared/client-id.ts`). Two invocations of the same script reuse the same clientID, with or without a daemon.

That leaves SQLite single-writer and WebSocket fan-out as the actual costs the daemon amortizes. Both can be addressed without an IPC sync wire:

- **SQLite single-writer**: keep the daemon as the *sole writer*. Scripts only READ the persistence file (and the materializer mirror file). Their own writes flow through cloud, which the daemon picks up via its existing cloud-sync attachment and persists.
- **WebSocket fan-out**: with WebSocket Hibernation API confirmed enabled in `apps/api/src/base-sync-room.ts:224`, awareness on-change-only (`packages/workspace/src/document/attach-sync.ts:1016`), and state-vector-aware reconnects (`apps/api/src/base-sync-room.ts:270-279`), each script's short-lived cloud WS costs sub-cent/month at any realistic usage. Fan-out is no longer a real cost driver for sequential scripts. It would still hurt for genuinely concurrent or long-lived peers, but those workloads are absent from the current target use cases.

The capability that scripts need from "syncing through the daemon" reduces to: **fast cold-start hydrate**. That capability is delivered better by reading the daemon's persistence file directly (single-writer + many-readers + WAL = no coordination, no IPC machinery).

## The new mental model

### Before: daemon as sync hub + materializer + RPC server

```
~/projects/fuji/
├── .epicenter/
│   ├── daemon.sock          ← IPC entry (sync + RPC, today)
│   ├── daemon.pid
│   ├── yjs/<id>.db  ← daemon writes (sole)
│   ├── sqlite/<id>.db ← daemon writes (sole)
│   └── md/                  ← daemon writes (sole)
└── scripts/

                    cloud WS (1)
       ┌────────────────────────────────┐
       │                                │
       ▼                                │
┌──────────────────────────┐    ┌───────┴──────┐
│ Daemon                   │    │ Cloud (DO)   │
│   Y.Doc                  │    └──────────────┘
│   attachSync (cloud WS)  │
│   attachSqlitePersistence │
│   attachSqliteMaterializer            ▲
│   attachMarkdownMaterializer          │ no direct
│   attachIpcSyncServer  ◄──┐           │ connection
│   /run RPC server  ◄────┐ │           │
└─────────────────────────┘ │           │
                            │           │
                            │ unix      │
                            │ socket    │
                            │           │
              ┌─────────────┴───────┐   │
              │ Script              │   │
              │   own Y.Doc         │   │
              │   attachIpcSyncClient   ┘
              │   /run RPC client (optional)
              │   attachSqliteMirror
              └─────────────────────┘
```

### After: daemon as materializer worker + (optional) RPC server

```
~/projects/fuji/
├── .epicenter/
│   ├── daemon.pid                       (a second daemon refuses to start)
│   ├── daemon.sock                      (only when /run RPC is enabled)
│   ├── yjs/<id>.db   ← daemon WRITES; scripts READ
│   ├── sqlite/<id>.db  ← daemon WRITES; scripts READ
│   └── md/                   ← daemon WRITES; scripts READ
└── scripts/

       cloud WS (one per process; cheap with hibernation)
       ┌──────────────────────────────────────────────┐
       │                                              │
       ▼                                              ▼
┌──────────────────────────┐                  ┌──────────────────────┐
│ Daemon (materializer)    │  ◄────────────►  │ Cloud (DO)           │
│   Y.Doc                  │                  └──────────────────────┘
│   attachSync (cloud WS)  │                          ▲
│   attachSqlitePersistence │                          │
│   attachSqliteMaterializer                          │
│   attachMarkdownMaterializer                        │
│   /run RPC server (optional)                        │
└──────────────────────────┘                          │
                                                      │ each script
                                              ┌───────┴──────────┐
                                              │ Script           │
                                              │   own Y.Doc      │
                                              │   attachSync     │ ← cloud WS
                                              │   reads          │
                                              │     persistence  │ ← warm hydrate
                                              │     materializer │ ← queries
                                              │   stable clientID│
                                              └──────────────────┘
```

## The trade-off table

The decisive comparison for "where do scripts persist their writes":

| Approach | Cold-start | Write path | Coordination cost |
|---|---|---|---|
| Script writes to its own .sqlite | Per-script, slow on first run | Cloud (or daemon via IPC) | Per-script files, extra disk, no benefit unless daemon is down |
| Script writes to shared .sqlite | Fast (reads daemon's writes) | Both write the same file | SQLite WAL serializes; daemon needs a watch/poll to know there's a new row |
| **Script reads-only daemon's .sqlite, writes to cloud** | **Fast (warm daemon-written file)** | **Cloud → daemon picks up via existing sync** | **None** |

The third row dominates. It's the cheapest model that actually works.

## Per-workspace persistence: why, and the multi-folder same-ID case

Persistence at `<workspaceDir>/.epicenter/yjs/<workspaceId>.db`, NOT at `~/.epicenter/yjs/<workspaceId>.db`. This is the existing layout; it stays.

Two folders on the same machine with the same `workspaceId` are two **replicas**, not two views of one shared store:

```
~/work/fuji/.epicenter/yjs/fuji.db    ~/personal/fuji/.epicenter/yjs/fuji.db
   ▲                                              ▲
   daemon A is sole writer                        daemon B is sole writer
   │                                              │
   └──── cloud WS ─────► Cloud (DO) ◄──── cloud WS ────┘
                              │
                         broadcasts each peer's writes
                         to the other; CRDT semantics
                         converge both Y.Docs.
```

After convergence, both folders' Y.Docs hold identical state. Both folders' persistence files become byte-equivalent (modulo write ordering). Same shape as a laptop + phone setup.

Why not global:
- **Single-writer is preserved naturally.** Each folder's daemon writes its own file. No cross-folder contention.
- **Materializer outputs follow the workspace.** Mirror.db and md/ are projections of *this* replica; they live in the workspace dir. Persistence has the same lifecycle.
- **Backup/delete granularity.** `rm -rf <workspaceDir>/.epicenter/` cleanly removes one workspace's local state. Global persistence would orphan rows.
- **Yjs models replicas, not checkouts.** Local-first apps already handle "many replicas of one logical workspace" correctly; we use that machinery.

What stays global at `~/.epicenter/`:
- Auth tokens
- deviceId
- Encryption-key derivation inputs

These are per-USER state, not per-replica.

## Two patterns

### Pattern 1 (canonical): one-shot script

```ts
// vault/scripts/tag-untagged.ts
import { openFuji } from '@epicenter/fuji/script';

using fuji = openFuji({ getToken });

const untagged = fuji.tables.entries
  .filter(e => !e.deletedAt && e.tags.length === 0);

fuji.batch(() => {
  for (const e of untagged) {
    fuji.tables.entries.update(e.id, { tags: ['untagged'] });
  }
});
```

`apps/fuji/src/lib/fuji/script.ts` exports `openFuji({ getToken, projectDir? })` that internally:

1. Constructs `new Y.Doc({ clientID: hashClientId(Bun.main) })`.
2. Calls `attachSqliteReadonlyPersistence(fuji.ydoc, { filePath })` against the daemon's persistence file at `<projectDir>/.epicenter/yjs/fuji.db` if it exists. This applies all rows to the local Y.Doc and *does not* attach a write listener. Warm hydrate; ~tens of ms for typical sizes. Skipped silently if the file is absent.
3. Calls `attachSync(fuji.ydoc, { url: CLOUD_URL, getToken })` — the same cloud-sync attachment the daemon and browser tabs use.
4. The script's writes flow through the cloud WS. The daemon (running its own `attachSync`) receives them, applies to its Y.Doc, writes to its persistence and materializer files.

The script never opens a unix socket. Never touches IPC sync. Never needs the daemon to be running, but benefits from it if it is (warm hydrate via the persistence file).

### Pattern 2 (worker): the daemon

```ts
// vault/epicenter.config.ts
import { openFuji } from '@epicenter/fuji/daemon';

const projectDir = import.meta.dir;

export const fuji = openFuji({ getToken: daemonAuth, projectDir });
export const workspaces = [fuji];
```

`apps/fuji/src/lib/fuji/daemon.ts` exports `openFuji({ getToken, projectDir })` that internally:

1. Constructs `openFuji()` from the core (no IO).
2. `attachSync(ydoc, { url: CLOUD_URL, getToken })`.
3. `attachSqlitePersistence(ydoc, { filePath: yjsPath(projectDir, 'fuji') })` — sole writer, WAL mode (see Phase 0).
4. `attachSqliteMaterializer(fuji, { db: sqlitePath(projectDir, 'fuji') })`.
5. `attachMarkdownMaterializer(fuji, { dir: markdownPath(projectDir, 'fuji') })`.

`epicenter serve`:
- Eagerly constructs each workspace from `epicenter.config.ts`.
- Mounts the `/run` RPC server at `<projectDir>/.epicenter/daemon.sock` (enabled by default; opt out with config).
- Stays up. Receives cloud broadcasts. Writes persistence + materializer files. Serves `/run` for typed action dispatch from CLI, scripts, browser, or curl.

No `attachIpcSyncServer`. No supervisor god function for IPC peer routing. Cloud sync is the only sync wire.

### Pattern 3 (escape hatch): direct in-process

For tests, one-shot migrations, or standalone tools that don't talk to anything:

```ts
const fuji = openFuji();
attachSqlitePersistence(fuji.ydoc, { filePath: ':memory:' });  // or a temp dir
fuji.tables.entries.set({ id: 'a', url: '...' });
```

In-process construction is just `new`. No factory wrapping it.

## Invariants

These are testable lock-ins.

1. **One sync wire.** `attachSync` (cloud WS) is the only sync transport. No `attachIpcSyncClient`, no `attachIpcSyncServer`.
2. **Daemon is sole writer of persistence and materializer files.** Scripts open these read-only. Multi-process write coordination is avoided by construction, not by locking.
3. **Scripts use stable clientIDs.** `hashClientId(Bun.main)` for any peer that mutates. State-vector growth bounded by distinct mutating scripts, not invocation count.
4. **`/run` RPC is preserved as an opt-in.** `connectDaemon<typeof openFuji>({ id })` returns a `Remote<W>` proxy that dispatches typed actions over the daemon's HTTP/JSON unix socket. Useful for the CLI and for tests; not the canonical script path.
5. **Per-workspace `.epicenter/` layout is preserved.** Persistence at `<projectDir>/.epicenter/yjs/<workspaceId>.db`. Materializer at `<projectDir>/.epicenter/sqlite/<workspaceId>.db`. Markdown at `<projectDir>/.epicenter/md/`. Daemon socket at `<projectDir>/.epicenter/daemon.sock` (when `/run` RPC is enabled).
6. **Per-user state stays at `~/.epicenter/`.** Auth, deviceId, encryption-key derivation.
7. **Multiple folders with the same workspaceId on one machine = two replicas.** Each folder's daemon writes its own files; they reconcile through cloud. Same shape as cross-device replicas.
8. **`epicenter serve` requires no IPC server config.** Removing `attachIpcSyncServer` removes a bootstrap option, not a runtime degradation.

## Phases

### Phase 0: prerequisite (must land first)

Goal: make the persistence file safe for concurrent readers and provide a readonly attachment for the script path.

1. **Rename `attachSqlite` to `attachSqlitePersistence`.** The qualifier puts it on equal footing with `attachSqliteMaterializer` in the role taxonomy (durability-of-Y.Doc-update-log vs projection-for-SQL-queries) instead of pretending one is the "default" SQLite attachment. Lives at `packages/workspace/src/document/attach-sqlite-persistence.ts`. Existing callers (`playground/opensidian-e2e/epicenter.config.ts`, `playground/tab-manager-e2e/epicenter.config.ts`) update their imports.
2. **Enable WAL on the persistence file.** Inside `attachSqlitePersistence`, after `new Database(filePath)`, run `db.run('PRAGMA journal_mode = WAL')`. Mirrors the materializer pragma at `packages/workspace/src/document/materializer/sqlite/sqlite.ts:335`. Wrap in try-catch logging the error via wellcrafted's `WalPragmaFailed` (some drivers and `:memory:` reject WAL); do not throw.
3. **Add a separate `attachSqliteReadonlyPersistence`.** A peer export at `packages/workspace/src/document/attach-sqlite-readonly-persistence.ts`. Signature:
   ```ts
   export function attachSqliteReadonlyPersistence(
     ydoc: Y.Doc,
     opts: { filePath: string },
   ): SqliteReadonlyPersistenceAttachment
   ```
   Behavior:
   - Existence check via `await Bun.file(filePath).exists()` inside the `whenLoaded` IIFE (Bun-native; matches the codebase's `Bun.file().exists()` convention used in e.g. `daemon/client.ts`). If the file is absent, `whenLoaded` rejects with `AttachSqliteReadonlyPersistenceError.MissingFile`. The error surfaces async (via the rejection), matching every other `attach*` function in the repo whose I/O failures flow through `whenLoaded` rather than a sync throw.
   - Opens with Bun's `{ readonly: true }`. No `CREATE TABLE`, no `PRAGMA WAL` (writer set it).
   - Replays existing rows: `SELECT data FROM updates ORDER BY id`, then `Y.applyUpdateV2` each.
   - Does NOT subscribe to `ydoc.on('updateV2')`. Does NOT schedule compaction. Mutating the reader's Y.Doc never flows back to disk.
   - `whenLoaded` resolves after replay; `whenDisposed` resolves after `db.close()` on `ydoc.destroy()`. No final compaction. No `clearLocal` (the readonly type omits it; this is the honest-asymmetry win over the original `readonly?: boolean` discriminator design).
4. Tests, split across two files matching the export split:
   - `attach-sqlite-persistence.test.ts`: WAL pragma applied to the file; round-trip (writer state survives reopen); `clearLocal` drops rows.
   - `attach-sqlite-readonly-persistence.test.ts`: round-trip (writer's 1k rows replay into a fresh reader doc); concurrent reader opens against an actively-writing daemon (no `SQLITE_BUSY`); missing-file rejects `whenLoaded` with `MissingFile` (async; matches the rest of the attach contract); reader-side mutations do not write back.

Why a peer export and not a `readonly?: boolean` flag on the writer: the two paths share an on-disk format and a 3-line replay loop, but no runtime state. The single-function shape forced fake-symmetric `clearLocal` (always rejected on readonly) and stale JSDoc on `whenDisposed` (the readonly path skips final compaction). Splitting matches the user's design memory ("honest asymmetry over fake symmetry: avoid transport/mode discriminators") and lets each return type carry only the operations it actually supports.

### Phase 1: additive (after Phase 0)

Goal: make the cloud-direct script path possible without removing anything.

1. **Add per-app `script.ts` factories.** Start with one app to validate the shape (`apps/fuji/src/lib/fuji/script.ts` or similar). Exports `openFuji({ getToken, projectDir? }): Promise<FujiHandle>`. Internally:
   - `openFuji()` (the core IO-free factory).
   - `attachSqliteReadonlyPersistence(ydoc, { filePath: yjsPath(projectDir, 'fuji') })` if the file exists; skip if not.
   - `attachSync(ydoc, { url: CLOUD_URL, getToken })`.
   - Wire `hashClientId(Bun.main)` into the Y.Doc's `clientID` (verify `openFuji` core supports passing in clientID; if not, that's a small ergonomic addition).
2. **Add per-app `daemon.ts` factories.** `apps/fuji/src/lib/fuji/daemon.ts` exports `openFuji({ getToken, projectDir }): FujiHandle`. Same shape as the existing inline boot code in `epicenter.config.ts`, just refactored into a function so the config file becomes one line.
3. **Migrate one consumer end-to-end.** Pick one `vault/scripts/*.ts` example. Switch its import from the (current, IPC-using) peer factory to the new `script.ts` factory. Verify it works against a running daemon (warm hydrate + cloud sync) and against no daemon (full cold sync).
4. Tests at the workspace package level (not app level):
   - `attachSqliteReadonlyPersistence` round-trip and concurrent-with-writer (these are Phase 0 tests; they live with the readonly module).
   - Two scripts running simultaneously, both with stable clientIDs, both writing via cloud: cloud and daemon converge to the same state.
   - Multi-folder same-ID: two folders running daemons with the same workspaceId reach byte-equivalent persistence files after settling.

### Phase 2: subtractive (after 1-2 weeks of dogfooding Phase 1)

Goal: delete the IPC sync transport and update the docs.

Files to delete (sourced from the punch-list audit):

```
DELETE — ~3,500 lines of transport code:
  packages/workspace/src/sync-ipc/
    ├── types.ts                      60
    ├── framing.ts                    66
    ├── framing.test.ts               77
    ├── write-queue.ts                72
    ├── listener.ts                  380
    ├── listener.test.ts             176
    ├── server.ts                    408
    ├── server.test.ts               384
    ├── client.ts                    637
    └── client.test.ts               304

  packages/workspace/src/client/sync-ipc.ts        (attachIpcSyncClient export)
  packages/workspace/src/daemon/sync-hub.ts        (attachIpcSyncServer export)

DELETE — ~620 lines of spike scaffolding:
  packages/workspace/.spikes/spike-1-cold-start.ts  87
  packages/workspace/.spikes/spike-1-test.ts        58
  packages/workspace/.spikes/spike-1-min.ts         60
  packages/workspace/.spikes/spike-1-min2.ts        58
  packages/workspace/.spikes/bun-write-repro.ts    (verify presence)

DELETE — ~325 lines of context docs:
  .context/sync-as-peer-spikes.md                  227
  .context/sync-as-peer-audit.md                    99

ARCHIVE (keep for history; mark "superseded"):
  specs/20260429T230000-sync-as-peer-transport.md
```

Files to modify (not delete):

```
MODIFY:
  packages/workspace/src/index.ts
    - remove any IPC re-exports
  packages/workspace/README.md
    - drop the IPC sync section (line ~1326)
  packages/workspace/docs/architecture/process-topology.md
    - remove the IPC sync transport row from the topology table
    - update the per-app diagram (the after-state above is the new canonical)
  docs/articles/20260429T235000-the-daemon-isnt-accidental.md
    - already corrected to reflect the honest reasoning
    - re-section: now the article describes the cloud-sync-only model
  .context/plans/reconcile-sync-as-peer-with-daemon-only-resources.md
    - rewrite to focus on cloud sync + filesystem reads only
```

Files that stay untouched:

```
KEEP:
  packages/workspace/src/document/attach-sync.ts   (cloud sync wire — still THE wire)
  packages/workspace/src/daemon/                   (RPC server stays)
    ├── app.ts
    ├── client.ts
    ├── paths.ts
    ├── run-handler.ts
    └── ...
  packages/workspace/src/client/connect-daemon.ts  (typed RPC client; opt-in for scripts)
  packages/workspace/src/client/sqlite-mirror.ts   (read-only mirror access)
  packages/workspace/src/client/markdown-mirror.ts (read-only markdown access)
  packages/workspace/src/shared/client-id.ts       (hashClientId)
  packages/workspace/src/shared/actions.ts         (defineMutation/Query)
```

### Phase 3 (optional, deferred): supervisor decomposition for cloud sync

`20260427T010000-supervisor-redesign.md` proposes decomposing `attach-sync.ts` into `Connection` / `SyncProtocol` / `Presence` / `RpcChannel` primitives. This was always orthogonal to the IPC question. With IPC gone, the supervisor's surface area is smaller (one transport instead of two), so the redesign is even easier. Land at convenience.

## Vision

Workspaces are first-class objects. You construct one in any process: browser tab, daemon, script, test. They differ only in which `attach*` primitives layer on top.

```
                            ┌──────────────────┐
                            │   openFuji()     │   ← core, IO-free
                            │   the workspace  │
                            └────────┬─────────┘
                                     │
             ┌───────────────────────┼───────────────────────┐
             │                       │                       │
       browser.ts                daemon.ts                script.ts
       openFuji()                openFuji()              openFuji()
             │                       │                       │
       attachIndexedDb         attachSqlitePersistence   attachSqliteReadonlyPersistence
       attachBroadcast         attachSync                attachSync
       attachSync              attachSqliteMaterializer
                               attachMarkdownMaterializer
                               (and `epicenter serve`
                                mounts /run RPC)
```

Cloud sync is the wire. Materializer outputs (mirror.db, md/) are owned by whichever long-lived process you choose to run. The daemon is special only because it owns those files; a browser tab is special only because it has IndexedDB; a script is special only because it's short-lived. They are all peers.

What this means for a developer:

```
First time using Epicenter:               In production:
──────────────────────────                ─────────────
1. Set up auth                            1. epicenter serve runs in background
2. bun run my-script.ts                      (materializer + /run endpoint)
   Script opens cloud WS, syncs,          2. Scripts run on demand:
   does work, exits. Done.                   bun run my-script.ts
                                              Warm hydrate from persistence
                                              + cloud diff. Sub-100ms cold start.
                                          3. Browser tabs hit cloud directly.
                                          4. CLI commands hit /run for queries
                                              that don't need a Y.Doc.
```

No "connect to a hub." No coordination dance. Just `openFuji({ getToken })` and use it.

## What this gains, plainly

Counted by line, not by argument:

- **Net deletion: ~4,500 lines** of recently-shipped IPC code, tests, and design docs.
- **One transport** instead of two. Fewer code paths in the supervisor; simpler mental model.
- **No IPC backpressure bugs to maintain** (the work from this week's commits `3b6d79c49` and `11c663d1f` is preserved for the daemon's own materializer flush, but the IPC-specific pieces go).
- **One factory pattern per environment.** `openFuji` from `script.ts`, `daemon.ts`, `browser.ts`. No `openFujiPeer` outlier.
- **Cloud server cost stays sub-cent/month** (verified: hibernation, on-change awareness, state-vector reconnects).

What it does not change:
- The daemon stays. It's still a long-lived process. It still owns persistence and materializers.
- `connectDaemon` typed RPC stays. CLI and tests can still dispatch typed actions over unix socket.
- Browser tabs work exactly as before.

## What this gives up

Honest list of capabilities that go away with IPC:

- **Hub-and-spoke fan-out for many concurrent local peers.** If your workload is "10 long-lived peer processes on the same machine, each watching for live updates," they'll each open a cloud WS instead of sharing one through the daemon. With WebSocket Hibernation this is essentially free in dollars, but it does mean N persistent connections to your DO instead of one. If this becomes a real workload later, IPC sync can be reintroduced for that specific case; the current target use case (one-shots + materializer) does not need it.
- **Cross-script awareness on the local machine.** Scripts won't see each other in the awareness map unless both are connected to cloud at the same time and the cloud broadcasts. For ephemeral scripts this is irrelevant.
- **The "daemon as transport for everything" mental model.** Scripts now have a more complex setup (load auth, open cloud WS, hydrate from persistence) than "open unix socket and go." The complexity is bounded by `openFujiPeer()` though; consumer code stays one-line.

## Decisions (formerly open questions)

1. **Persistence format.** Verified append-only with periodic compaction (`packages/workspace/src/document/attach-sqlite-persistence.ts` + `packages/workspace/src/document/sqlite-update-log.ts:49-63`). 2 MB threshold, 5-second debounce. Reads cleanly: scan rows in `id` order, apply each via `Y.applyUpdateV2`. **No format change. Read path is straightforward.**

2. **WAL on the persistence file.** Phase 0 enabled it inside `attachSqlitePersistence`. Mirrors the materializer's WAL pragma so a concurrent `attachSqliteReadonlyPersistence` consumer can open the same file without `SQLITE_BUSY`. **Resolved in Phase 0.**

3. **Auth refresh.** One-off scripts run sub-3 minutes; well within typical JWT lifetimes (1 h+). **Non-issue. No refresh logic needed in `script.ts` factories.**

4. **Encryption keys in scripts.** Scripts load key derivation inputs from `~/.epicenter/`. Filesystem perms gate the dir. Same threat surface as scripts that already call `connectDaemon`. **Non-issue.**

5. **`/run` RPC default.** Keep enabled. The pattern "daemon as action server, hit endpoints from anywhere" is real and useful (CLI, bash, scripts that want atomicity, tools without a Yjs SDK). Cost is one HTTP route. **Leave on by default; opt out via config if a deployment doesn't want it.**

6. **clientID collision risk** (newly surfaced by the Yjs grounding pass). 53-bit hash, ~5×10⁻⁹ collision probability at 10k distinct scripts on one machine. Failure mode under collision: Yjs's `cleanupTransactions` rotates the colliding peer's clientID; writes at the overlapping `(clientID, clock)` are silently dropped on integration. The daemon itself uses a random 53-bit clientID, so it shares the same risk space. **Acceptable. Document the failure mode in the `hashClientId` JSDoc; do not add collision detection.**

## Cross-references

- Punch list of files to delete: this spec, Phase 2 section.
- Honest reasoning behind dropping the IPC argument: `docs/articles/20260429T235000-the-daemon-isnt-accidental.md` (corrected version).
- Cloud cost verification: `apps/api/src/base-sync-room.ts:224, 270-279` and `packages/workspace/src/document/attach-sync.ts:1016`.
- Stable clientID derivation: `packages/workspace/src/shared/client-id.ts`.
- Persistence shape (verified append-only): `packages/workspace/src/document/attach-sqlite-persistence.ts` and the readonly peer at `packages/workspace/src/document/attach-sqlite-readonly-persistence.ts`.
- Daemon's RPC channel that survives: `packages/workspace/src/daemon/{app.ts,client.ts,run-handler.ts}` and `packages/workspace/src/client/connect-daemon.ts`.

## Handoff prompt for Phase 0 implementation

> **Historical (Phase 0 landed).** The original prompt prescribed a single `attachSqlite(ydoc, { filePath, readonly?: boolean })` discriminator. During implementation we split it into `attachSqlitePersistence` + `attachSqliteReadonlyPersistence` (two files, two return types) for honest asymmetry; see Phase 0 above for the landed design. Preserved below for history.

```
TASK: Implement Phase 0 of specs/20260429T235500-daemon-as-materializer-worker.md.
Two surgical changes to packages/workspace/src/document/attach-sqlite.ts:

CHANGE 1: enable WAL mode on the persistence file.
  After the `new Database(filePath)` line (~line 59), add:
    try { db.run('PRAGMA journal_mode = WAL') } catch (e) {
      // mirrors the materializer pragma at sqlite.ts:335; some test
      // drivers and `:memory:` reject WAL — log and continue.
      logger.warn('attach-sqlite: WAL pragma failed', { cause: e })
    }
  Use the existing logger import in the file (or add one consistent
  with packages/workspace/src/document/materializer/sqlite/sqlite.ts).

CHANGE 2: add `readonly?: boolean` option to the `attachSqlite` signature.
  Current signature:
    export function attachSqlite(
      ydoc: Y.Doc,
      { filePath }: { filePath: string },
    ): SqliteAttachment
  New signature:
    export function attachSqlite(
      ydoc: Y.Doc,
      { filePath, readonly }: { filePath: string; readonly?: boolean },
    ): SqliteAttachment

  When `readonly === true`:
    - Open with `new Database(filePath, { readonly: true })`. Do NOT run
      `CREATE TABLE IF NOT EXISTS updates ...` (file must already exist;
      throw a typed error early if it doesn't, do not silently succeed).
    - Run the existing replay flow: SELECT data FROM updates ORDER BY id,
      apply each via `Y.applyUpdateV2(ydoc, row.data)`.
    - DO NOT subscribe to `ydoc.on('updateV2')`. No write listener.
    - DO NOT schedule compaction. No timer.
    - The returned SqliteAttachment's `whenLoaded` resolves after replay.
    - The returned SqliteAttachment's `whenDisposed` resolves immediately
      after `db.close()` on dispose. No final compaction.
    - `clearLocal` should throw `Error('attachSqlite: clearLocal disabled
      in readonly mode')` if called.

  When `readonly === undefined || readonly === false`: existing behavior
  unchanged. Verify by running existing tests against the modified file.

TESTS to add (packages/workspace/src/document/attach-sqlite.test.ts or new file):

  1. WAL pragma is set after open (read PRAGMA journal_mode and assert "wal").
  2. Readonly round-trip:
     - Daemon-style: `attachSqlite(daemonDoc, { filePath })`, write 1k entries
       through the daemon's Y.Doc, await whenLoaded.
     - Script-style: fresh Y.Doc, `attachSqlite(scriptDoc, { filePath, readonly: true })`,
       await whenLoaded, assert scriptDoc has same state as daemonDoc.
  3. Concurrent reader: daemon attached and actively writing in a loop;
     concurrently open a second readonly attachment. No SQLITE_BUSY.
     Reader gets a snapshot consistent with one of the in-flight commit
     points (does not need to be the latest).
  4. Missing-file error: `attachSqlite(ydoc, { filePath: '/nonexistent.db', readonly: true })`
     throws a typed error before returning the attachment.
  5. Readonly write listener absent: in readonly mode, mutating scriptDoc
     does NOT cause INSERT into the file (open the file from a third
     attachment after the script writes; row count unchanged).

CONSTRAINTS:
  - bun, never npm/yarn/pnpm/node (this codebase uses Bun only).
  - No em/en dashes anywhere — code, comments, commit messages, tests.
  - wellcrafted Result/defineErrors at boundaries; tryAsync for awaits
    that can throw at IO boundaries.
  - Do not modify the materializer (different file, different concern).
  - Do not touch sync-ipc/ — Phase 2 deletes it; we are not there yet.
  - One commit per change (one for WAL pragma, one for readonly option +
    tests). Commit messages follow the existing style: `feat(workspace):
    <imperative>` or `fix(workspace): <imperative>`.

VALIDATION:
  - cd packages/workspace && bun test (all existing tests pass).
  - New tests above pass.
  - cd packages/workspace && bun run typecheck (no new errors).

OUT OF SCOPE for this phase:
  - Phase 1 (per-app script.ts / daemon.ts factories).
  - Phase 2 (deleting sync-ipc/).
  - Any changes to the materializer.
  - Any changes to attach-sync.ts.

If you discover anything in Phase 0 that contradicts the spec
(e.g., readonly behavior depends on internals I'm not aware of),
STOP and surface it before continuing. Do not paper over it.
```

## Handoff prompt for Phase 1 implementation

Run after Phase 0 lands. Self-contained.

```
TASK: Implement Phase 1 of specs/20260429T235500-daemon-as-materializer-worker.md.
Add per-environment factory files for the Fuji app, following the pattern
already established by apps/fuji/src/lib/fuji/browser.ts. Two new files
plus tests. No deletions.

PRECONDITIONS:
  - Phase 0 is merged: persistence is split into two exports.
    Verify by reading both before starting:
      packages/workspace/src/document/attach-sqlite-persistence.ts
      packages/workspace/src/document/attach-sqlite-readonly-persistence.ts
    The writer enables WAL on the file; the readonly hydrator opens
    the same file `{ readonly: true }` and rejects `whenLoaded` with
    `MissingFile` when the file is absent.
  - apps/fuji/src/lib/fuji/index.ts exports the IO-free `openFuji()` core.
  - apps/fuji/src/lib/fuji/browser.ts exports `openFuji(auth, device)`
    with attachIndexedDb + attachBroadcastChannel + attachSync. Read this
    file first; copy its shape.

CONTEXT (why this exists):
  Workspaces are first-class objects constructed in any process. Three
  environments: browser (already has a factory), daemon (long-lived
  worker that owns persistence + materializer files), script (short-lived
  process that reads daemon's persistence read-only and syncs to cloud).
  The factory files expose the same `openFuji` name from different files;
  importer chooses by path. See spec §"Vision" and §"Two patterns".

CHANGE 1: apps/fuji/src/lib/fuji/daemon.ts (NEW FILE)
  Exports `openFuji({ auth, device, projectDir })` for `epicenter serve`.
  Internal sequence:
    1. Construct the core via `openFuji(...)` from ./index.ts. Pass any
       arguments the core accepts (read index.ts to see).
    2. attachSync(handle.ydoc, { url: CLOUD_URL, auth }) — reach for the
       same attachSync the browser variant uses; URL constant lives at
       the same path browser.ts imports it from.
    3. attachSqlitePersistence(handle.ydoc, { filePath: <persistence path> }) where
       <persistence path> is computed via the existing path helper. Look
       in packages/workspace/src/daemon/paths.ts for `yjsPath`,
       `sqlitePath`, `markdownPath`, etc. If a helper named
       `yjsPath(projectDir, workspaceId)` does NOT exist, add it
       there alongside the existing helpers (mirror the existing
       socketPathFor / mirrorPathFor signatures); the spec calls for the
       layout `<projectDir>/.epicenter/yjs/<workspaceId>.db`.
    4. attachSqliteMaterializer(handle, { db: sqlitePath(projectDir, 'fuji') }).
    5. attachMarkdownMaterializer(handle, { dir: markdownPath(projectDir, 'fuji') }).
    6. Return the handle with all attachments composed into it. Match the
       composition style browser.ts uses (Object.assign, spread, or
       whatever is idiomatic in that file).

  Argument shape: copy browser.ts's signature exactly except add `projectDir`.
  If browser.ts is `openFuji(auth, device)`, then daemon.ts is
  `openFuji({ auth, device, projectDir })` or the same positional shape with
  projectDir appended. Stay consistent; do not invent a new style.

CHANGE 2: apps/fuji/src/lib/fuji/script.ts (NEW FILE)
  Exports `openFuji({ auth, projectDir? })` for one-off scripts. Internal
  sequence:
    1. Compute clientID via `hashClientId(Bun.main)` from
       packages/workspace/src/shared/client-id.ts.
    2. Construct the core via `openFuji(...)`. If the core does not
       accept a `clientID` option today, add support for one as part of
       this change (small ergonomic addition; pass through to
       `new Y.Doc({ clientID })`).
    3. Resolve projectDir: if not provided, use a discovery helper. If the
       codebase already has `findEpicenterDir()` or similar, use it.
       If not, default to `process.cwd()` and document the assumption
       in JSDoc.
    4. Compute yjsPath(projectDir, 'fuji'). Always call
       `attachSqliteReadonlyPersistence(handle.ydoc, { filePath })` and
       await its `whenLoaded`. If the file is missing, the attachment
       rejects whenLoaded with `MissingFile { name, filePath }` —
       catch this specific variant and proceed (the script will cold-
       sync from cloud instead). Re-throw any other rejection. Pattern:
         const ro = attachSqliteReadonlyPersistence(handle.ydoc, { filePath });
         try { await ro.whenLoaded } catch (err) {
           if (err?.name !== 'MissingFile') throw err
           // file absent: warm hydrate skipped, fall through to cloud sync
         }
       Do NOT pre-check existence with Bun.file().exists() then call: the
       readonly attachment already does that check, and racing it from
       the caller adds nothing.
    5. attachSync(handle.ydoc, { url: CLOUD_URL, auth }).
    6. Return the handle.

  Use `await using` semantics if the existing factories do; otherwise
  return a handle with explicit dispose. Match the pattern of
  browser.ts.

CHANGE 3: package.json export paths
  apps/fuji/package.json (or wherever fuji's package exports live):
  ensure `./script` and `./daemon` are exposed alongside `./browser`.
  Run `cd apps/fuji && bun run typecheck` to verify imports work.

TESTS to add:

  Workspace package level
  (packages/workspace/src/document/attach-sqlite-readonly-persistence.test.ts):
    - readonly hydrate matches writer state for 1k entries (Phase 0
      should already cover this; verify it does, do not duplicate).

  App level (apps/fuji/src/lib/fuji/script.test.ts and daemon.test.ts):
    - script.ts: openFuji with no daemon present (no persistence file)
      yields an empty Y.Doc; cloud sync would populate it (mock or
      stub the WS, do not require a real cloud server).
    - script.ts: openFuji with a pre-populated persistence file applies
      its rows on construction. Use a fixture: write a persistence file
      with the daemon-mode factory in beforeAll, then open with the
      script-mode factory, assert state matches.
    - daemon.ts: openFuji constructs all five attachments without
      throwing; whenReady (or equivalent) resolves; tearing down the
      handle disposes them in reverse order without errors.
    - hashClientId(Bun.main) is the actual clientID on the Y.Doc
      returned by script.ts (read handle.ydoc.clientID, compare).

CONSTRAINTS:
  - bun, never npm/yarn/pnpm/node.
  - No em or en dashes anywhere in code, comments, tests, or commits.
  - wellcrafted Result/defineErrors at boundaries; tryAsync for awaits
    that can fail at IO.
  - Do not modify the IPC sync transport (sync-ipc/). That's Phase 2.
  - Do not modify the materializer code paths.
  - Match the existing convention in apps/fuji/ — same naming, same
    composition style, same export shape. Do not invent.
  - Three commits maximum: one for any path-helper additions in
    packages/workspace/src/daemon/paths.ts (if needed), one for
    daemon.ts + tests, one for script.ts + tests. Commit messages:
    `feat(fuji): <imperative>`.

VALIDATION:
  - cd packages/workspace && bun test (no regressions).
  - cd apps/fuji && bun test (new tests pass).
  - cd apps/fuji && bun run typecheck (no new errors).
  - Hand-verify imports work:
      bun -e "import { openFuji } from '@epicenter/fuji/script'; console.log(typeof openFuji)"
      bun -e "import { openFuji } from '@epicenter/fuji/daemon'; console.log(typeof openFuji)"

OUT OF SCOPE:
  - Migrating any other app (whispering, tab-manager, etc.). Fuji only.
  - Phase 2 (deleting sync-ipc/). Sequencing matters: keep sync-ipc/
    intact for now.
  - Touching attach-sync.ts.
  - Adding a vault directory or example scripts (those come later).
  - Creating a CLI command for scripts.

If apps/fuji/src/lib/fuji/index.ts does NOT export openFuji, or its core
shape is incompatible with passing a clientID, STOP and report what you
found. Do not refactor the core to fit.
```

## Handoff prompt for Phase 2 implementation

Run after Phase 1 has been used in real workloads for 1-2 weeks and the
script + daemon factories cover the use cases. Self-contained.

```
TASK: Implement Phase 2 of specs/20260429T235500-daemon-as-materializer-worker.md.
Delete the IPC sync transport and update affected docs and specs. Net
deletion ~4,500 lines. Surgical.

PRECONDITIONS:
  - Phase 0 (WAL + attachSqlitePersistence/attachSqliteReadonlyPersistence split) merged.
  - Phase 1 (apps/fuji/src/lib/fuji/{script,daemon}.ts) merged AND in
    use for at least one real workload.
  - Confirm no app code imports anything from packages/workspace/src/sync-ipc/
    BEFORE deleting. Run:
      rg -l "sync-ipc|attachIpcSync(Client|Server)" \
        --glob '!packages/workspace/src/sync-ipc/**' \
        --glob '!**/*.test.ts' \
        --glob '!specs/**' \
        --glob '!docs/**' \
        --glob '!.context/**'
    Expect zero hits in production source. If anything matches in apps/*,
    packages/cli/, or packages/workspace/src/index.ts, STOP and migrate
    those callers before deleting.

CONTEXT:
  The IPC Yjs-sync transport is being removed in favor of "scripts open
  their own cloud WebSocket and read the daemon's persistence file
  read-only for warm hydrate." See spec §"Why this exists" and
  §"What gets deleted".

  What survives: the daemon process, attachSqlitePersistence and its
  readonly peer attachSqliteReadonlyPersistence,
  attachSqliteMaterializer, attachMarkdownMaterializer,
  attach-sync.ts (cloud sync wire), the daemon's HTTP/JSON /run RPC
  server, connectDaemon (typed RPC client), sqlite-mirror.ts and
  markdown-mirror.ts (read-only mirror access), hashClientId.

DELETIONS (~4,450 lines total):

  Whole directory:
    packages/workspace/src/sync-ipc/                          ~2,564 lines
      types.ts, framing.ts, framing.test.ts, write-queue.ts,
      listener.ts, listener.test.ts, server.ts, server.test.ts,
      client.ts, client.test.ts

  Individual files:
    packages/workspace/src/client/sync-ipc.ts                 (attachIpcSyncClient)
    packages/workspace/src/daemon/sync-hub.ts                 (attachIpcSyncServer)

  Spike files:
    packages/workspace/.spikes/spike-1-cold-start.ts
    packages/workspace/.spikes/spike-1-test.ts
    packages/workspace/.spikes/spike-1-min.ts
    packages/workspace/.spikes/spike-1-min2.ts
    packages/workspace/.spikes/bun-write-repro.ts             (verify presence;
                                                               delete if exists)

  Context docs:
    .context/sync-as-peer-spikes.md
    .context/sync-as-peer-audit.md

  Verify each file exists before `git rm`. Do not delete files that
  the precondition grep flagged as still-referenced.

EXPORT CLEANUP:

  packages/workspace/src/index.ts:
    - Remove any re-exports referencing attachIpcSyncClient,
      attachIpcSyncServer, sync-ipc types (DuplexChannel, IpcPreamble,
      etc.). Run:
        rg "sync-ipc|IpcSync|IpcChannel|IpcPreamble|attachIpcSync"
      against the file before and after to confirm clean.

  packages/workspace/src/daemon/index.ts (if exists):
    - Same audit. Remove any IPC-related re-exports.

  packages/cli/ — verify nothing in serve.ts or related boots an IPC
    server. The daemon should construct only attachSync,
    attachSqlitePersistence, attachSqliteMaterializer,
    attachMarkdownMaterializer, plus the
    /run HTTP RPC server. If serve.ts references attachIpcSyncServer,
    remove that line (the daemon factory in apps/fuji/src/lib/fuji/daemon.ts
    is now the canonical wiring).

DOC UPDATES:

  packages/workspace/README.md:
    - Drop the section that documents attachIpcSyncClient
      (around line 1326 per the audit).
    - Add a one-paragraph note that scripts use attachSync directly
      and may use attachSqliteReadonlyPersistence for warm hydrate.

  packages/workspace/docs/architecture/process-topology.md:
    - Already partially corrected by previous edits. Now also:
      - Remove any remaining row in the "transports" table that
        describes IPC sync.
      - Update the per-app diagram to show two transports
        (cloud sync, mirror filesystem reads) instead of three.

  docs/articles/20260429T235000-the-daemon-isnt-accidental.md:
    - Already corrected. Re-read for consistency now that IPC is gone.
      The article currently still describes "sync-as-peer" as the
      chosen approach. Update the closing section to describe the
      cloud-direct + readonly-persistence approach.

  .context/plans/reconcile-sync-as-peer-with-daemon-only-resources.md
    (if it exists): rewrite to reflect cloud sync + filesystem reads.
    If irrelevant after rewrite, delete it.

SPEC SUPERSESSION:

  specs/20260429T230000-sync-as-peer-transport.md:
    - At the top, add a "Status: SUPERSEDED" banner pointing at
      specs/20260429T235500-daemon-as-materializer-worker.md.
    - Do NOT delete; specs are durable history.

TESTS:
  - Run `cd packages/workspace && bun test` before each commit. Should
    progressively shrink; existing passing tests must continue to pass.
  - Run `cd packages/workspace && bun run typecheck` after the export
    cleanup commit; expect zero errors.
  - Run `cd apps/fuji && bun test` to confirm app still builds.

CONSTRAINTS:
  - bun, never npm/yarn/pnpm/node.
  - No em or en dashes.
  - Multiple atomic commits, one per logical group:
      1. `chore(workspace): delete sync-ipc transport`
         (the whole packages/workspace/src/sync-ipc/ dir + the two
         attachIpcSync* files in client/ and daemon/)
      2. `chore(workspace): clean up IPC exports and CLI wiring`
         (index.ts re-export removal, cli/serve.ts cleanup if needed)
      3. `chore(workspace): delete IPC spike scaffolding`
         (the .spikes/ files and .context/ audit docs)
      4. `docs(workspace): update topology and README for cloud-direct sync`
      5. `docs(spec): mark sync-as-peer-transport spec superseded`
  - Do not skip pre-commit hooks. If a hook fails, fix the cause and
    create a new commit; do not amend.
  - Do not push or open a PR; leave that to the user.

VALIDATION:
  - All five commits land cleanly.
  - `bun test` passes at each commit.
  - `bun run typecheck` passes at each commit.
  - `git log --stat origin/main..HEAD` shows the expected file
    deletions and approximate line counts.
  - Run the precondition grep again after deletion; expect zero
    results (everything truly gone).

OUT OF SCOPE:
  - Migrating other apps (whispering, etc.) to script.ts/daemon.ts.
    They can stay on the existing pattern until their own migration.
  - Adding new features to the surviving daemon. Phase 2 is purely
    subtractive.
  - Refactoring attach-sync.ts (the supervisor redesign is its own spec
    at 20260427T010000).

If the precondition grep returns nonzero results in a place you cannot
explain, STOP and surface it. Do not delete files that something
references; either migrate the caller first or escalate.
```
