# @epicenter/cli

> Introspect and invoke `defineQuery` / `defineMutation` actions exposed by configured project mounts, locally or on a peer that's online right now.

Each verb is a one-line shell shortcut for one workspace primitive:

```
                 +--------+---------------------------------------------+
                 | Verb   | Workspace primitive                         |
                 +--------+---------------------------------------------+
   Enumerate     | list   | Object.entries(collaboration.actions)       |
   Invoke        | run    | actions[key](input) or dispatch(peer, ...)  |
   Presence      | peers  | collaboration.devices.list()                |
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

Tokens are stored per API target so prod and local sessions coexist. Each target writes one file at `<dataDir>/auth/<host>.json`, where `<dataDir>` is the platform user-data directory from `env-paths('epicenter')` and `<host>` is the API host with `:` replaced by `_`. A fresh `cli:local auth login` will not overwrite your prod session. When `EPICENTER_API_URL` is set, the CLI prints `Using API at <url>.` to stderr once per process. The daemon freezes its target at boot; to retarget, `daemon down` then `daemon up` again.

`EPICENTER_DATA_DIR=<path>` overrides `<dataDir>` itself (the user-data directory above; today the only user-global state stored there is cached credentials). Escape hatch for Nix, snap, ephemeral homes, and the test suite.

The same env var and scripts apply to every command that talks to the API, including `daemon`, not just `auth`.

## Commands

`epicenter daemon up` opens every mount listed in the project's `epicenter.config.ts`. `list`, `run`, and `peers` dispatch to that local daemon over its Unix socket.

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

`-C` is a start directory for project discovery. Discovery walks upward until it finds `epicenter.config.ts`, then the daemon starts every mount in that config.

## Project Mounts

`epicenter.config.ts` owns project discovery. The default export is a `Mount` (single mount) or a `Mount[]` (multi-mount). App packages ship a mount factory that returns a `Mount` carrying its own canonical name.

```ts
import { fuji } from '@epicenter/fuji/project';

export default fuji();
```

The factory carries the canonical mount name (`fuji`), so the CLI addresses actions as `fuji.<action_key>` regardless of the project folder name.

For projects that host more than one app workspace, export an array:

```ts
import { fuji } from '@epicenter/fuji/project';
import { honeycrisp } from '@epicenter/honeycrisp/project';

export default [fuji(), honeycrisp()];
```

```
my-project/
├── epicenter.config.ts
└── .epicenter/
```

Writing a custom mount inline uses `defineMount` from `@epicenter/workspace/daemon`:

```ts
import { defineMount } from '@epicenter/workspace/daemon';

export default defineMount({
	name: 'notes',
	async open({ keyring, openWebSocket, projectDir, mount, ownerId, deviceId, yDocClientId }) {
		// Open the long-lived local runtime.
		// `mount` is the canonical mount name carried on the Mount object.
		// Return { collaboration, [Symbol.asyncDispose] }.
	},
});
```

`Mount.name` is the CLI prefix. Two mounts in one project must have distinct names; duplicates fail before any mount opens.

`.epicenter/` holds generated project data such as SQLite materializers, Yjs update logs, markdown materializers, and its generated `.gitignore`. It is not a registry. Runtime files live outside the project: sockets and daemon metadata use the OS runtime directory, while daemon logs use the platform log directory from `env-paths`.

## Scripting

Use scripts for anything beyond one-shot CLI calls:

```ts
import { connectDaemonActions } from '@epicenter/workspace/node';
import type { createFujiActions } from '@epicenter/fuji';

const fuji = await connectDaemonActions<ReturnType<typeof createFujiActions>>({
	mount: 'fuji',
});

await fuji.entries_update({ id, tags: ['triaged'] });
```

Scripts get normal TypeScript control flow. The CLI stays small: list, run, peers, and daemon lifecycle.

## Public API

```ts
import { createCLI } from '@epicenter/cli';
```
