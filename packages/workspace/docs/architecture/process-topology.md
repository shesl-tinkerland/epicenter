# Process Topology

> **Companion docs:** [Network Topology](./network-topology.md) describes how Y.Docs sync between machines (the WAN view). This doc describes how processes on a single machine talk to a workspace (the LAN/IPC view). See also [Action Dispatch](./action-dispatch.md) for cross-device action invocation, which is a third, distinct transport.

A workspace lives in some process that holds a live `Y.Doc`. Other processes need access to that workspace's data and actions. Epicenter solves this with two transports for two different audiences:

| Transport | Who uses it | Crosses devices? | Wire | Lives where |
|---|---|---|---|---|
| **WebSocket Yjs sync** | Processes that own a Y.Doc and want to converge with peers | Yes, via the sync server | CRDT updates over WS | `attachSync` ([README §Sync](../../README.md#sync)) |
| **Unix socket `/run`** | Local processes that have no Y.Doc and want to RPC into one that does | No, same machine only | JSON over IPC | `epicenter serve` daemon, `connectDaemon` client |
| **Y.Doc requests table** | Cross-device action calls when only one peer can do the work | Yes, via the sync server | Mailbox in the Y.Doc itself | See [Action Dispatch](./action-dispatch.md) |

This document focuses on the **first two** and how they compose. The third is documented separately and rides on top of the first.

## The Three Process Roles

Every Epicenter process plays one of three roles relative to a given workspace:

```
┌──────────────┬──────────────────────────────┬──────────────────────────┐
│  Role        │  Owns a live Y.Doc?          │  How it reaches data     │
├──────────────┼──────────────────────────────┼──────────────────────────┤
│  Browser tab │  Yes (in-process)            │  Direct Y.Doc mutation;  │
│  (e.g. fuji) │                              │  attachSync to converge  │
│              │                              │  with other Y.Doc owners │
├──────────────┼──────────────────────────────┼──────────────────────────┤
│  Daemon      │  Yes (in-process)            │  Direct Y.Doc mutation;  │
│  (epicenter  │                              │  attachSync to converge  │
│   serve)     │                              │  with other Y.Doc owners │
│              │                              │  PLUS exposes /run on a  │
│              │                              │  unix socket             │
├──────────────┼──────────────────────────────┼──────────────────────────┤
│  CLI / bun   │  No                          │  Unix socket /run into   │
│  script      │                              │  the local daemon        │
└──────────────┴──────────────────────────────┴──────────────────────────┘
```

The single most important thing to internalize: **the browser tab and the daemon are siblings, not parent and child.** Both attach a Y.Doc to the sync server. They converge with each other through the sync server, never directly. The daemon is "another sync client that happens to also be an IPC server for processes that didn't want to be sync clients themselves."

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
            │  ─ own Y.Doc            │   │  started by `epicenter serve`│
            │  ─ attachIndexedDb      │   │  ─ own Y.Doc                 │
            │  ─ attachSync ───────┐  │   │  ─ attachSqlite              │
            │  ─ tables / actions  │  │   │  ─ attachSync ───────┐       │
            │                      │  │   │  ─ tables / actions  │       │
            │  fuji.tables.X.set() │  │   │                      │       │
            │   ↓                  │  │   └─┬───────────┬────────┴───────┘
            │  direct Y.Doc mutate │  │     │ unix      │ unix
            └──────────────────────┘  │     │ socket    │ socket
                                      │     │ /run      │ /run
                                      │     ▼           ▼
                                      │  ┌──────┐   ┌────────────┐
                                      │  │ CLI  │   │ bun script │
                                      │  │ epi  │   │ connect    │
                                      │  │ run  │   │ Daemon()   │
                                      │  └──────┘   └────────────┘
                                      │
                       Both Y.Doc owners converge through the
                       sync server. The unix socket is a local
                       IPC channel into the daemon's Y.Doc only.
```

## Same Call Shape, Three Execution Models

The workspace API is designed so the **call shape is the same** in all three roles for the JSON-friendly subset (CRUD verbs, `defineQuery` / `defineMutation` actions). What differs is execution.

### A) In-process (browser tab)

```ts
// apps/fuji/src/lib/fuji/client.ts
import { fuji } from '$lib/fuji/client';   // singleton; owns its Y.Doc

const tabs = fuji.tables.entries.getAllValid();        // sync, in-memory
await fuji.actions.savedTabs.create({ url });          // mutates the local Y.Doc directly
fuji.tables.entries.observe((ids) => rerender(ids));   // live subscription, no problem
fuji.tables.entries.filter((r) => r.starred);          // closure, no problem
```

The full Table API surface from [`attach-table.ts`](../../src/document/attach-table.ts) is available, including methods that take closures or are subscriptions.

### B) Long-lived process (daemon, started by `epicenter serve`)

The daemon is constructed by *the same builder code* you would call in-process. The config file at `epicenter.config.ts` runs in the daemon's process and exports a workspace bundle:

```ts
// playground/opensidian-e2e/epicenter.config.ts (excerpt)
import { attachEncryption, attachSqlite, attachSync, toWsUrl } from '@epicenter/workspace';

const ydoc = new Y.Doc({ guid: WORKSPACE_ID });
const tables = attachEncryption(ydoc).attachTables(ydoc, opensidianTables);
const sync = attachSync(ydoc, { url: toWsUrl(`${SERVER_URL}/workspaces/${WORKSPACE_ID}`), ... });

export const opensidian = {
  whenReady: Promise.all([persistence.whenLoaded, unlock.whenChecked, sync.whenConnected]),
  actions, sync, tables, ydoc,
  [Symbol.dispose]() { ydoc.destroy(); },
};
```

`epicenter serve` loads this file, awaits `whenReady`, binds a unix socket at `<dir>/.epicenter/daemon.sock`, and parks. From the daemon's own perspective, it is just a Y.Doc-owning process exactly like the browser tab. From the outside, it also speaks `/run`.

### C) Remote via daemon (CLI and bun scripts)

```ts
// any bun script on the same machine as the daemon
import { connectDaemon } from '@epicenter/workspace';
import type { openFuji } from '@apps/fuji';

const ws = await connectDaemon<ReturnType<typeof openFuji>>('fuji');

const tabs = await ws.tables.entries.getAllValid();    // unix socket round-trip
await ws.actions.savedTabs.create({ url });            // daemon runs the action
// ws.tables.entries.observe(...)  ← throws RemoteNotSupported
// ws.tables.entries.filter(fn)    ← throws (predicate is a closure)
```

The CLI is the same shape from a shell:

```bash
epicenter serve &                                       # role B in the background
epicenter run savedTabs.create '{"url": "..."}'         # role C, fire-and-forget
epicenter run tables.entries.getAllValid                # role C, read-back
```

## What Crosses the Wire and What Doesn't

The unix socket carries JSON. That alone determines the wire-callable subset:

| Method | Wire? | Why |
|---|---|---|
| `get`, `getAllValid`, `set`, `update`, `delete`, `bulkSet` | Yes | JSON in, JSON out |
| `defineQuery` / `defineMutation` actions | Yes | JSON in, JSON out |
| `filter(predicate)`, `find(predicate)` | No | Closure cannot serialize. Pull rows with `getAllValid()` and filter in the client, or define an action with a serializable arg. |
| `observe(callback)` | No | Push subscription. `/run` is request/response. A future streaming socket could carry it; not implemented today. |
| `ydoc`, document handles | No | Live CRDT objects cannot serialize. |

The remote-side type ([`remote-workspace-types.ts`](../../src/client/remote-workspace-types.ts)) deliberately excludes the unserializable methods so call sites do not reach for them. The runtime proxy throws [`RemoteNotSupported`](../../src/client/remote-not-supported.ts) for dynamic property access against the excluded names so failures are loud rather than `undefined`.

## Why Two Transports and Not One

A reasonable instinct: "Why does the daemon exist? Couldn't a CLI just attach its own Y.Doc and sync, like the browser tab does?"

It could, and that path was previously planned (see the deprecated local-mesh in [Network Topology](./network-topology.md)). It has serious costs for short-lived processes:

1. **Startup latency.** Spinning up a Y.Doc, hydrating from local persistence, and waiting for a sync handshake is multi-second work. `epicenter run` should feel like `curl`, not like booting an app.
2. **Encryption boundary.** The daemon holds the workspace's encryption keys. Forking that key material into every shell script is worse for security than keeping it in one long-lived process and granting filesystem-permissioned IPC.
3. **One source of truth on the device.** Two scripts running concurrently with their own Y.Docs would race and write divergent local persistence. The daemon collapses them to one local writer.
4. **Subscription and presence are inherently long-lived.** `awareness`, `peers()`, materializers (markdown, sqlite, filesystem) need a process that stays up. The daemon already provides it.

So the daemon exists to **amortize the cost of being a sync client** for the local machine. Browsers pay that cost themselves because they are already a long-lived UI process; CLI invocations and scripts piggyback.

## Cross-References

- [README §Sync](../../README.md#sync): the `attachSync` primitive both Y.Doc owners use to reach the sync server.
- [Network Topology](./network-topology.md): the WAN-side picture; how Y.Doc owners (browser tabs, daemons) converge across machines via the sync server.
- [Action Dispatch](./action-dispatch.md): the third transport, used when an action must run on a *specific* peer rather than the local daemon.
- [Device Identity](./device-identity.md): how peers and the daemon identify themselves to the sync server.
- [Security](./security.md): trust boundaries between processes, the sync server, and disk.
- `packages/cli/src/commands/serve.ts`: the daemon entry point.
- `packages/workspace/src/client/connect-daemon.ts`: the client constructor for role C.
- `packages/workspace/src/daemon/{app,table-actions,run-handler}.ts`: the wire's daemon side.
