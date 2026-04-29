# @epicenter/cli

> Introspect and invoke `defineQuery` / `defineMutation` actions in your `epicenter.config.ts`, either locally or on a peer that's online right now.

Each verb is a one-line shell shortcut for one workspace primitive:

```
                 ┌──────────┬───────────────────────────────────┐
                 │   Verb   │          Workspace primitive      │
                 ├──────────┼───────────────────────────────────┤
   Enumerate     │  list    │  describeActions(workspace.actions)
   Invoke        │  run     │  invokeAction(...)  /  sync.rpc(...)
   Presence      │  peers   │  workspace.sync.peers()
                 │  peers <id>  + describePeer(sync, id)
                 └──────────┴───────────────────────────────────┘

 Cross-cutting: auth (server session, pre-workspace)
```

`list` is the local view of what *this* device exposes. `peers` is the
remote view: who is online, and (with a deviceId) what they expose.
`run --peer <deviceId>` invokes one of those remote actions.

Anything that would need a flag to fan out across peers, loop, or
compose is a user-authored `.ts` script that imports the config and
runs under `bun run`. The CLI is the shell-friendly surface; scripts
are the automation surface.

## Installation

Inside this monorepo:

```json
{
    "dependencies": {
        "@epicenter/cli": "workspace:*"
    }
}
```

The package exposes the `epicenter` binary via `src/bin.ts`.

## The four commands

`run`, `list`, and `peers` dispatch to the local `epicenter up` daemon for the resolved `--dir`. Start it once at the top of your session (`epicenter up &`), then run as many shell-shortcut commands as you want; without `up`, those three verbs error with a hint pointing back here. `up`, `down`, `ps`, `logs`, and `auth` work without a daemon.

```bash
# auth — server session (pre-workspace; no --dir or --workspace)
epicenter auth login                              # defaults to https://api.epicenter.so
epicenter auth login https://self-hosted.example  # self-hosted override
epicenter auth status                             # most recent session
epicenter auth logout                             # most recent session

# up — bring the workspace online as a callable peer (run once per session)
epicenter up &

# list — what actions are exposed on this device
epicenter list                                      # full tree
epicenter list tabManager.savedTabs                 # subtree
epicenter list tabManager.savedTabs.create          # action detail with JSON input shape

# run — do one (locally, or on a remote peer with --peer)
epicenter run tabManager.savedTabs.list
epicenter run tabManager.savedTabs.create '{"title":"Hi","url":"https://..."}'
epicenter run tabManager.savedTabs.create @payload.json
cat payload.json | epicenter run tabManager.savedTabs.create
epicenter run tabManager.savedTabs.list --peer 0xabc

# peers — who's online right now (presence snapshot)
epicenter peers
epicenter peers -w tabManager
epicenter peers 0xabc                               # presence + that peer's action tree
```

`run` resolves the first path segment against the named exports of `epicenter.config.ts`; everything after walks into the underlying document handle until it hits a branded `defineQuery` / `defineMutation` node.

### Local vs. remote

`list` is local: it describes the actions exposed by this device's
config. Per-peer schema introspection lives on `peers <deviceId>`,
which calls `describePeer(sync, id)` over RPC and returns presence plus
the peer's full action tree. `run` is local by default and remote when
`--peer <deviceId>` is set; the verb and schema are unchanged, only the
dispatch target moves.

Fan-out across peers (e.g. "who exposes action X?") is a five-line
script that walks `workspace.sync.peers()` and calls `describePeer`
on each. The CLI deliberately does not grow a flag for it.

Peer presence has a ~30s liveness window (inherited from Yjs awareness): a peer that crashed recently may still appear; a peer that just connected may take a beat to show up. `run --peer` polls for the target until it resolves or `--wait <ms>` expires (default 5000). `peers <deviceId>` polls up to `--wait <ms>` (default 500). Without arguments, `peers` reads the current awareness snapshot one-shot.

### Common flags

| Flag | Alias | Commands | Purpose |
| ---- | ----- | -------- | ------- |
| `--dir` | `-C` | `list`, `run`, `peers` | Directory containing `epicenter.config.ts` (default `.`). Mirrors `git -C`. |
| `--workspace` | `-w` | `list`, `run`, `peers` | Narrow to one export when the config has multiple workspaces. |
| `--peer` | — | `run` | Address a remote peer by `deviceId`. Dispatches the invocation over the sync room's RPC channel. |
| `--wait` | — | `run --peer` (default 5000), `peers <deviceId>` (default 500) | Ms to wait for awareness to populate. On `run --peer`, covers peer resolution *and* the RPC call. |
| `--format` | — | `list`, `run`, `peers` | `json` or `jsonl`. Pretty-prints on TTY, compact when piped. Without it, commands emit their human-readable shape (tree / value / table). |

`auth` intentionally takes no workspace flags — it manages server sessions, not workspace state. The server URL is a positional with a default of `https://api.epicenter.so`; self-hosters pass their own URL.

### Exit codes

Scripts can distinguish these cases without parsing stderr:

| Code | Meaning |
| ---- | ------- |
| `1` | Usage or setup error — unknown command, bad flag, missing config, action path doesn't exist, workspace name doesn't match. |
| `2` | Runtime error — local action returned `Err`, or a remote RPC completed with a failure (ActionFailed, Timeout, PeerOffline, Disconnected). |
| `3` | Peer miss — `--peer <target>` did not resolve within `--wait`. Distinct from `2` so scripts can retry or re-enumerate peers. |

## What your `epicenter.config.ts` must export

An **opened workspace** — call your `openX()` factory at module top-level so the export is already constructed (Y.Doc made, attachments wired, sync ready to connect). No framework wrapper, no `.open()` step — just a plain function the CLI consumes via the export.

```ts
// epicenter.config.ts
import * as Y from 'yjs';
import {
    defineTable,
    attachTables,
    defineQuery,
    defineMutation,
} from '@epicenter/workspace';
import Type from 'typebox';
import { type } from 'arktype';

const SavedTab = defineTable(type({ id: 'string', title: 'string', url: 'string', _v: '1' }));

function openTabManager() {
    const ydoc = new Y.Doc({ guid: 'epicenter.tab-manager' });
    const tables = attachTables(ydoc, { savedTabs: SavedTab });

    return {
        ydoc,
        tables,

        // Actions live beside the data they operate on.
        // Only the operations you wrap with defineQuery/defineMutation
        // show up in `epicenter list`.
        savedTabs: {
            list: defineQuery({
                description: 'List all saved tabs',
                handler: () => tables.savedTabs.getAllValid(),
            }),
            delete: defineMutation({
                input: Type.Object({ id: Type.String() }),
                description: 'Delete a saved tab by id',
                handler: ({ id }) => tables.savedTabs.delete(id),
            }),
        },

        [Symbol.dispose]() { ydoc.destroy(); },
    };
}

// The opened workspace is what the CLI and scripts consume.
export const tabManager = openTabManager();
```

## Exposing operations via CLI

There is no auto-expose for `attachTable` / `attachKv` methods. If you want an operation available at `epicenter run`, wrap it in `defineQuery` or `defineMutation` inside your bundle. Expose only what you actually want available from the CLI — everything else stays as an in-process method on the Table/Kv helper, usable from `scripts/*.ts`.

This is deliberate. Auto-exposing CRUD would put methods nobody asked for in your CLI tree, and the curated set would either be too narrow for some apps or too wide for others. Explicit wrapping keeps the CLI surface intentional and small.

The convention is to group related actions into a nested object named after the domain they operate on:

```ts
return {
    ydoc,
    tables,

    savedTabs: {                                       // domain
        list: defineQuery({ ... }),                    // action
        delete: defineMutation({ ... }),
    },
    bookmarks: {
        list: defineQuery({ ... }),
    },

    // Cross-cutting actions live at the top
    importBackup: defineMutation({ ... }),

    [Symbol.dispose]() { ydoc.destroy(); },
};
```

CLI paths: `tabManager.savedTabs.list`, `tabManager.bookmarks.list`, `tabManager.importBackup`.

The framework doesn't mandate this shape — `iterateActions` walks the whole bundle and finds anything branded, no matter where it sits. Two other placements work if you prefer them:

- A dedicated `actions:` slot — adds one path segment (`tabManager.actions.savedTabs.list`) in exchange for visual separation between data and operations.
- Flat at the top — shortest path (`tabManager.listSavedTabs`) but action names have to encode the domain, and the top level becomes a grab-bag.

Domain-nested is the recommended convention because it reads naturally and co-locates each action with the data it uses.

## Naming your exports

Every workspace handle is a **named export**. The export name becomes the first segment of every CLI dot-path. A config with a single workspace can use any name — `tabManager`, `tm`, `w` — but once you add a second workspace, the prefix disambiguates them, so a readable name ages better than a one-letter one.

There is no default-export shorthand. Even a config with one workspace uses a named export. This keeps paths stable when you later add a second workspace: `tabManager.savedTabs.list` on day 1 is still `tabManager.savedTabs.list` on day 180 after you add a second workspace. A default-export shortcut would silently invalidate every script, doc, and CI job using the old path the moment you grew past one workspace.

```ts
// epicenter.config.ts
export const tabManager = openTabManager();
export const fuji       = openFuji();
// epicenter run tabManager.savedTabs.list
// epicenter run fuji.entries.list
```

The Y.Doc GUID (set inside `openX()` via `new Y.Doc({ guid: ... })`) and the export name serve **different purposes**:

- `'epicenter.tab-manager'` — the Y.Doc's GUID. Controls persistence file, sync room, CRDT identity. Don't change this on a workspace with real data.
- `tabManager` — the JS binding name. Controls the CLI path prefix. Safe to rename any time.

You can rename the export freely without touching any persistent data. If you decide the prefix is too verbose six months in, rename `tabManager` → `tm` and every sync/persistence artifact stays exactly where it is.

## Scripting

Skip the CLI entirely for anything non-trivial:

```ts
// scripts/export-tabs.ts
import { tabManager } from '../epicenter.config';
import { writeFile } from 'node:fs/promises';

try {
    await tabManager.whenReady;
    const tabs = tabManager.tables.savedTabs.getAllValid();
    await writeFile('./tabs.json', JSON.stringify(tabs, null, 2));
} finally {
    tabManager.dispose();
}
```

```bash
bun run scripts/export-tabs.ts
```

Scripts are strictly more powerful than the CLI: you get the full Table/Kv APIs, arbitrary control flow, and any npm dependency. Reach for the CLI for one-shot invocations of things you've deliberately exposed; reach for scripts for everything else.

## Public API

```ts
import {
    createCLI,              // binary entry (used by bin.ts)
    loadConfig,             // { entries: [{ name, handle }], dispose() }
    createSessionStore,     // device-code session persistence
    createAuthApi,          // typed Better Auth client
    epicenterPaths,         // home, authSessions
    attachSessionUnlock,    // apply stored encryption keys to an EncryptionAttachment
} from '@epicenter/cli';
```

## Design docs

- `specs/20260421T155436-cli-scripting-first-redesign.md` — base surface (`auth`, `list`, `run`) and the scripting-first rationale; why 11 commands collapsed to the current grid.
- `specs/20260423T174126-cli-remote-peer-rpc.md` — the remote column: `peers` + `run --peer` over the sync room's RPC channel.
- `specs/20260423T010000-cli-json-only-input.md` — `run` takes JSON only; no schema-to-flags bridge.
