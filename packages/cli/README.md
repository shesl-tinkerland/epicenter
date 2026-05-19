# @epicenter/cli

> Introspect and invoke `defineQuery` / `defineMutation` actions exposed by folder-routed daemon extensions, locally or on a peer that's online right now.

Each verb is a one-line shell shortcut for one workspace primitive:

```
                 +--------+---------------------------------------------+
                 | Verb   | Workspace primitive                         |
                 +--------+---------------------------------------------+
   Enumerate     | list   | Object.entries(collaboration.actions)       |
   Invoke        | run    | actions[key](input) or dispatch(peer, ...)  |
   Presence      | peers  | collaboration.peers.list()                  |
                 +--------+---------------------------------------------+

 Supporting systems: auth (machine session), daemon (process lifecycle)
```

## Targeting an environment

When you iterate on `apps/api`, you want CLI commands hitting your local server, not prod. The CLI reads `EPICENTER_API_URL` from the environment; named scripts wrap the two real workflows so the target is always explicit.

| I want to... | I run... |
| --- | --- |
| Develop against my local API server | `bun run cli:local auth login` |
| Run from source against prod (rare: bug repro, demos) | `bun run cli auth login` |
| Use the published binary (end user) | `epicenter auth login` |
| Override the target anywhere | `EPICENTER_API_URL=https://staging.example.com bun run cli auth login` |

Tokens are stored per host so prod and local sessions coexist. The prod host writes `~/.epicenter/auth.json`; any other host writes `~/.epicenter/auth.<host>.json` with `:` replaced by `_`. So `http://localhost:8787` lands at `~/.epicenter/auth.localhost_8787.json`, and a fresh `cli:local auth login` will not overwrite your existing prod session. When the env var is set, the CLI prints `Using API at <url>.` to stderr once per process. The daemon freezes its target at boot; to retarget, `daemon stop` and start it again.

The same env var and scripts apply to every command that talks to the API, including `daemon`, not just `auth`.

## Commands

`epicenter daemon up` opens every `workspaces/<route>/daemon.ts` extension for the project. `list`, `run`, and `peers` dispatch to that local daemon over the project socket.

```bash
epicenter auth login

epicenter daemon up -C ~/vault
epicenter daemon ps
epicenter daemon logs -C ~/vault
epicenter daemon down -C ~/vault

epicenter list -C ~/vault
epicenter list fuji.entries_update -C ~/vault

epicenter run fuji.entries_update '{"id":"entry_1","tags":["triaged"]}' -C ~/vault
epicenter run fuji.entries_update '{"id":"entry_1","tags":["triaged"]}' --peer user-1 -C ~/vault

epicenter peers -C ~/vault
```

`-C` is a start directory for project discovery. Discovery walks upward until it finds `workspaces/` or `.epicenter/`.

## Daemon Extensions

The daemon is the local runtime host for workspace apps. It does not own an app's schema or UI. It discovers trusted workspace source, opens each long-lived runtime once, and serves the route's actions over a project-local socket.

One folder is one route:

```
my-vault/
├── workspaces/
│   └── fuji/
│       ├── daemon.ts
│       └── workspace.ts
└── .epicenter/
```

`workspaces/fuji/daemon.ts` default-exports a daemon workspace module:

```ts
export { default } from '@epicenter/fuji/daemon';
```

The folder name is the CLI route prefix. `workspaces/fuji/daemon.ts` exposes actions as `fuji.<action_key>`.

`.epicenter/` is runtime state, not registration. The daemon writes its socket, logs, Yjs update logs, SQLite mirrors, and materialized files there after a route starts.

An app-owned daemon module receives host capabilities from the daemon process: `projectDir`, `route`, deterministic `clientId`, `installationId`, `attachEncryption`, and `openWebSocket`. Fuji uses those capabilities to open the shared workspace, attach the Yjs log, attach sync, expose action handlers, and materialize entries into SQLite and Markdown.

## Scripting

Use scripts for anything beyond one-shot CLI calls:

```ts
import { connectDaemonActions } from '@epicenter/workspace/node';
import type { createFujiActions } from '@epicenter/fuji';

const fuji = await connectDaemonActions<ReturnType<typeof createFujiActions>>({
	route: 'fuji',
});

await fuji.entries_update({ id, tags: ['triaged'] });
```

Scripts get normal TypeScript control flow. The CLI stays small: list, run, peers, and daemon lifecycle.

## Public API

```ts
import { createCLI } from '@epicenter/cli';
```
