# Workspace process topology

How workspaces are hosted across processes, who owns what state, and how scripts and the CLI reach a workspace's data. This doc covers the runtime picture: apps, daemons, scripts, and the unix-socket transport that connects them.

If you want the schema/define/attach picture, read [`architecture.md`](../architecture.md). This doc picks up after that and answers "where does a workspace actually run, and how do other processes talk to it."

## The picture

```
                 ┌────────── epicenter API ──────────┐
                 │             (cloud)                │
                 │                                    │
        WebSocket│                                    │WebSocket
                 │                                    │
                 ▼                                    ▼
        ┌─────────────────┐                  ┌─────────────────┐
        │     daemon      │                  │   whispering    │
        │  (epicenter     │                  │    (Tauri)      │
        │     serve)      │                  │                 │
        │                 │                  │   workspace     │
        │   workspace     │                  │   (in-proc)     │
        │   (in-proc)     │                  └─────────────────┘
        └────────┬────────┘
                 │                           ┌─────────────────┐
            unix socket                      │   tab-manager   │
                 │                           │ (chrome ext)    │
                 ▼                           │                 │
        ┌─────────────────┐                  │   workspace     │
        │   CLI / scripts │                  │   (in-proc)     │
        │     (bun)       │                  └─────────────────┘
        └─────────────────┘
```

There are three classes of process in this picture, and they have three different jobs.

**Workspace hosts** boot a workspace in-process, sync it to the cloud, and stay alive. Whispering, tab-manager, dashboard, and the daemon are all workspace hosts. They differ in runtime (Tauri, browser extension, browser, bun) and in whether they have a UI, but they play the same architectural role: they own a local replica of the workspace and synchronize it with the cloud.

**The daemon** is a workspace host with no UI. It runs in bun under `epicenter serve`, holds the workspace alive, runs materializers, and exposes a unix socket so other local bun processes can talk to it. It's the headless analogue of an app.

**Clients** (the CLI, user scripts) don't host a workspace. They open the daemon's unix socket, send typed RPC, and render the result. They have no in-memory Y.Doc, no persistence, no sync session. They're remote controls for the daemon.

The cloud API is the only path between hosts. Apps and daemons sync through it as peers. There is no app-to-daemon channel and no daemon-to-app channel; both go through the cloud.

## What apps do with `tables.X.set`

Direct in-process call. No proxy, no daemon involvement. The app updates its own Y.Doc; the sync extension picks up the local update and ships it to the cloud over WebSocket; the cloud broadcasts to other connected peers (including the daemon, if one is running for that workspace); each peer absorbs the update into its own Y.Doc and re-runs its materializers.

```
whispering.tables.recordings.set(row)
  │
  ▼
in-memory Y.Doc.transact(() => yTable.set(row))
  │
  ▼
sync extension picks up the local update
  │
  ▼
WebSocket → epicenter API
  │
  ▼
API broadcasts → daemon's WS, dashboard's WS, ...
  │
  ▼
each peer's local Y.Doc absorbs the update
  │
  ▼
each peer's materializers / sqlite mirrors react
```

Apps cannot RPC to a unix socket on a random desktop, so the daemon is irrelevant to them. Apps and daemons are siblings, not parent and child.

## What scripts do with `tables.X.set`

Scripts go through the daemon. The daemon owns the workspace; the script is a typed client that sends RPC over the unix socket.

```
script process:
  fuji.tables.entries.update({ id, title })
    │
    ▼
  POST /run { actionPath: "tables.entries.update", input: {...} }
    │
    ▼ unix socket
  ┌──────────────────────────────────────────┐
  │ daemon process:                           │
  │   validate input against schema           │
  │   actions.entries.update.handler(input)   │
  │     ├─ tables.entries.update (in-proc)    │
  │     ├─ Y.Doc transact                     │
  │     └─ sync extension picks up update     │
  │   return Result<T, E>                     │
  └──────────────────────────────────────────┘
    │
    ▼ unix socket
  Result<T, E> rendered or returned
```

The script never holds a workspace. The daemon's workspace is the source of truth; scripts mutate it remotely. From the cloud's perspective, the daemon is the writer; the script is invisible.

## The single-writer constraint

There is at most one workspace process per `(absDir, workspaceId)` pair on a machine.

CRDTs tolerate many writers, but the layers above CRDTs do not:

- file-backed SQLite persistence has one WAL writer at a time
- the materializer writes to a directory tree; two materializers race on the same files
- awareness has one slot per `clientID`, and a `clientID` is per-Y.Doc-session
- the cloud sync session is per-process; two processes for the same workspace mean two clients

This is the constraint that decides every other architectural choice in this doc.

## Identity: three axes

A workspace has three identity axes that don't overlap:

```
workspaceId       — the logical workspace (e.g. 'epicenter.fuji')
                    Determined by epicenter.config.ts. Same across machines.
                    Multiple folders on one machine can hold replicas of the
                    same workspaceId.

absDir            — where this local replica lives
                    The folder containing epicenter.config.ts. Determines
                    the daemon's socket path and the local persistence path.
                    Two folders = two replicas, even if same workspaceId.

deviceId          — which physical machine
                    Per-install (one per laptop). Same across all replicas
                    on the same machine. Two replicas in two folders show
                    up in the peer list as the same device with two
                    different clientIDs.
```

A folder + workspaceId combination uniquely identifies a local replica. Two such combinations on the same machine are two independent replicas, syncing through the cloud, just like two laptops.

The optional `deviceName` field passed into a workspace's IO wrapper gives a human-readable name to the replica's presence row. The deviceId stays global; the name is presentation only:

```ts
const fuji = openFuji();
const sync = attachSync(fuji, { url, getToken, device: { id: deviceId, name: 'vault-prod', platform: 'bun' } });
```

In the peer list, this surfaces as `MacBook Pro [vault-prod]`. Useful when you run multiple replicas on the same machine; ignorable otherwise.

## State scoping: local vs global

State splits cleanly along one axis: is it about a specific workspace replica, or about the user / machine?

```
LOCAL — <absDir>/.epicenter/

  persistence/<workspaceId>.db    Y.Doc updates (the CRDT itself)
  materializer/<workspaceId>.db   sqlite mirror outputs
  <materializer-defined dirs>     markdown trees, etc.
  logs/                           daemon stdout/stderr per-instance

GLOBAL — ~/.epicenter/

  auth/sessions.json              OAuth tokens (per user)
  encryption keys (derived)       same identity → same keys
  device-id                       per-machine identifier
```

Per-workspace-replica state is local. Per-user-or-per-machine identity is global. The line is "if I move this folder to another machine, what travels with it?" — the local stuff travels, the global stuff doesn't.

Two daemons running on the same machine in different folders are isolated at the local layer (separate persistence, separate materializer outputs) and shared at the identity layer (same auth, same encryption keys, same deviceId). They merge through the cloud, not through shared local files.

## The wire contract: `defineMutation` and `defineQuery`

The daemon's unix socket exposes one main route, `/run`, plus presence (`/peers`) and a manifest (`/list`). Everything else is a body shape.

The rule for what's RPC-callable is uniform: **anything wrapped with `defineMutation` or `defineQuery` is on the typed wire.** Both wrappers capture an input schema (Standard Schema-compatible: arktype, TypeBox, etc.) and a handler. The wrapping does double duty: it's the runtime registration and the type-level contract for clients.

Tables auto-generate their CRUD wrappers from the table schema, so `tables.entries.set`, `tables.entries.update`, etc. are themselves `defineMutation` instances generated at `defineTable` time. The script-side surface is identical whether a method was hand-written by the workspace author or auto-generated:

```ts
// Auto-generated from defineTable(entrySchema):
tables.entries.update  →  defineMutation({
  input: partialOf(entrySchema, { keep: ['id'] }),
  handler: ({ id, ...patch }) => entriesTable.updateRaw(id, patch),
})

// Hand-written by the workspace author:
actions.entries.create  →  defineMutation({
  input: type({ 'title?': 'string', 'tags?': 'string[]' }),
  handler: ({ title, tags }) => { ... },
})
```

Both flow through the same `/run` route, validate the same way, return `Result<T, E>` the same way. The daemon doesn't distinguish them on the wire; the client doesn't distinguish them in the type system.

The action manifest at `/list` is data, not code. Tooling that wants to introspect the API (LSP autocomplete, MCP tool exposure, generated CLI subcommands) consumes the manifest. This falls out of `defineMutation` / `defineQuery` capturing schemas; nothing extra to design.

### What's NOT on the wire

Three operations stay in-process only and throw `RemoteNotSupported` when called through a remote client:

- `tables.X.filter(predicate)` — predicate is a JS function, can't cross the wire. Workaround: client-side `(await getAllValid()).filter(fn)`.
- `tables.X.observe(callback)` — needs streaming. Defer until real demand.
- `documents.X.Y.open(id)` — returns a stateful Y.Doc handle. Can't be RPC'd. Use actions for document mutations, or call your in-process builder if you genuinely need to manipulate the doc.

These are escape hatches, not gaps in the wire model. Most scripts don't need any of them.

## The front door: `connectDaemon`

Scripts and the CLI both reach a remote workspace through one function:

```ts
import { connectDaemon } from '@epicenter/workspace';
import { openFuji } from '@epicenter/fuji/workspace';

using fuji = await connectDaemon<typeof openFuji>({
  id: 'epicenter.fuji',
  absDir: '/Users/braden/Code/vault',  // optional; defaults to upward search
});

const entries = await fuji.tables.entries.getAllValid();
await fuji.actions.entries.update({ id, title: 'New' });
```

`typeof openFuji` is type-only at runtime. TypeScript reads `openFuji`'s return type to shape the remote client; the function body never executes in the script process. The script holds a unix socket and a typed RPC stub: no Y.Doc, no SQLite, no sync session locally.

`absDir` is optional. If omitted, `connectDaemon` walks parent directories from `process.cwd()` looking for an `epicenter.config.ts` or `.epicenter/` marker, the way `git` finds the repo root. Pass it explicitly when you need to address a workspace outside the cwd's tree.

There is **no** `transport: 'remote' | 'local'` discriminator. In-process is a fundamentally different operation from connecting over a socket: in-process is `new`, connecting is RPC. The system reflects that. There is no `connectLocal`. If you want an in-process workspace, you call your builder directly:

```ts
using fuji = openFuji({ auth, device });
await fuji.whenReady;
```

That asymmetry is deliberate. A unified `connect(..., { transport })` would silently re-introduce the multi-writer problem if a daemon happened to be running while a script asked for `local`. We'd rather have two distinct call sites than one whose semantics depend on a string flag.

When no daemon is up:

```
$ bun run scripts/tag-untagged.ts
no daemon running for /Users/braden/Code/vault;
start one with `epicenter serve` first
```

Same error the CLI gives. No auto-spawn.

## Two patterns: canonical and escape hatch

### Canonical: scripts as daemon clients

This is what 95% of vault-style scripting looks like. Start the daemon, write scripts, run them. The daemon stays alive across many script invocations, materializers run continuously, sync stays connected, awareness shows you on the peer list.

```bash
$ epicenter serve &           # one-time, in a long-lived shell
$ bun run scripts/tag-untagged.ts
$ bun run scripts/list-entries.ts
$ bun run scripts/create-entry.ts "New thought"
$ epicenter list entries      # CLI uses the same daemon
```

Inside the script:

```ts
import { connectDaemon } from '@epicenter/workspace';
import { openFuji } from '@epicenter/fuji/workspace';

using fuji = await connectDaemon<typeof openFuji>({ id: 'epicenter.fuji' });

const untagged = (await fuji.tables.entries.getAllValid())
  .filter(e => e.tags.length === 0);

for (const entry of untagged) {
  await fuji.actions.entries.update({ id: entry.id, tags: ['untagged'] });
}
```

The script is a thin remote control. The daemon does the work. `using` triggers `[Symbol.dispose]` at scope exit, which closes the socket; the daemon's workspace stays alive.

### Escape hatch: call the builder directly

For cases where the canonical pattern doesn't fit:

- **Heavy migrations.** "Rewrite all entries to add a new field." Run in-process with no daemon, like a Postgres migration that locks the table.
- **Document or observe operations.** If you need `documents.entries.content.open(id)` to mutate rich-text bodies in a script, you need in-process. The daemon doesn't expose document handles.
- **Standalone tools without a config.** A backfill that pulls from a third-party API and writes to a workspace. Boots in-process, syncs to cloud, exits.

The escape hatch is not a different API; it's calling your builder yourself:

```ts
import { openFuji } from '@epicenter/fuji/workspace';
// ... plus whatever IO this tool needs (SQLite, sync, materializers) ...

using fuji = bootFujiInProcess({ absDir: import.meta.dir, /* ... */ });
await fuji.whenReady;
// full in-process workspace: observe, documents, filter all work
```

The constraint: **no daemon may be running on the same `(absDir, workspaceId)` while an in-process workspace is active.** SQLite file locking will surface this as a clean error if you try.

## The server is a function

`epicenter serve` is a thin CLI wrapper around an exported function. Advanced users and alternative deployments can embed the server directly:

```ts
import { createWorkspaceServer } from '@epicenter/workspace';
import { fuji, tabManager, workspaces } from './epicenter.config';

const server = await createWorkspaceServer({
  absDir: import.meta.dir,
  workspaces,  // [fuji, tabManager], pre-constructed by the config file
});

await server.listen();
```

`epicenter.config.ts` is daemon-only by convention. It eagerly constructs each workspace it hosts and exports a `workspaces` array as the boot manifest. Each entry's id is `ws.ydoc.guid`; there is no separate id-to-constructor mapping, because the workspace knows its own id. Scripts do **not** import `epicenter.config.ts`; they import constructors from packages and use `connectDaemon` to talk to the running daemon.

The CLI command is "load config, call this function, exit on signal." Nothing more. Embedded mode is supported because the core is exported, not because there's a parallel API.

## When the daemon is worth it

Not every workspace needs a daemon. The daemon earns its keep when there's a headless reason for the workspace to stay alive:

| use case                                                            | daemon? |
|---------------------------------------------------------------------|---------|
| vault: markdown materializer, sqlite mirror, no UI app              | yes     |
| CLI scripting against live data from a known absDir                 | yes     |
| sharing workspace state across multiple short-lived bun processes   | yes     |
| whispering on its own (the app is the workspace host)               | no      |
| dashboard / honeycrisp / other web apps on their own                | no      |

Whispering doesn't need a daemon because Whispering itself is the headless-ish process for its data: it stays open, syncs to cloud, that's enough. Vault has no app, so the daemon plays the role Whispering plays for its own workspace.

If you ever ask "does my project need a daemon," the test is: **is there work that should happen when no UI is open?** If yes, daemon. If no, don't bother.

## Why no auto-spawn

`connectDaemon` does not spawn a daemon for you. This is a deliberate choice.

Auto-spawning would require: lock files so concurrent first-spawns don't race, somewhere for daemon stdout/stderr to go, an idle policy for shutdown, crash recovery, and a "is this daemon mine" reconciliation step. Each is bounded; together they're a maintenance surface, paid for an aesthetic gain ("user didn't have to type `epicenter serve`").

The tax is small and obvious. Postgres makes you start it. Redis makes you start it. The same applies here. If auto-spawn ever becomes worth it, it can be added later without changing any client code: the front door is `connectDaemon({ id })`, and what happens if no daemon is up is implementation, not API.

## Wire-protocol versioning

The daemon exposes a built-in `list` query (a `defineQuery` instance, dispatched through `/run` like every other typed call) that returns its manifest. The manifest includes the workspace package version the daemon was built against. Clients can refuse to connect on major-version mismatch; minor-version drift is handled by `@hono/standard-validator` returning typed 400s when a client sends a body the daemon doesn't recognize.

In a monorepo, daemon and client share the same version automatically. The version field matters when vault (or another consumer repo) pins `@epicenter/workspace` separately from a daemon built at a different version.

## Summary

- **Apps and daemons are peers**, both syncing to the cloud. They don't talk to each other directly.
- **The daemon is the headless workspace host.** Same role as an app, no UI.
- **Scripts and the CLI are clients of the daemon**, connecting via unix socket.
- **One workspace process per `(absDir, workspaceId)`**, enforced by SQLite file lock.
- **Per-workspace state is local; per-user identity is global.**
- **`connectDaemon<typeof openX>({ id, absDir? })`** is the front door for talking to a remote workspace. There is no front door for in-process: you call your builder directly.
- **`defineMutation` and `defineQuery` are the only wire-level contract.** Tables auto-generate their CRUD wrappers; users add more. Built-in queries (`peers`, `list`) flow through the same `/run` route.
- **Three operations stay in-process only**: `filter` (with predicate), `observe`, `documents.open`. Throw `RemoteNotSupported` over the wire.
- **No auto-spawn.** Daemon is started explicitly with `epicenter serve`.
- **The daemon owns auth.** Scripts pass no tokens. Filesystem permissions on the unix socket gate access.
