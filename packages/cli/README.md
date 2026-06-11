# @epicenter/cli

> Introspect and invoke `defineQuery` / `defineMutation` actions exposed by configured project mounts, locally or on a peer that's online right now.

Each verb is a one-line shell shortcut for one workspace primitive:

```
                 +------------+---------------------------------------------+
                 | Verb       | Workspace primitive                         |
                 +------------+---------------------------------------------+
   Enumerate     | list       | Object.entries(collaboration.actions)       |
   Invoke        | run        | local daemon invoke                         |
   Dispatch      | run --peer | relay dispatch to a live peer               |
   Presence      | peers      | collaboration.devices.list()                |
                 +------------+---------------------------------------------+

 Supporting systems: auth (machine session), daemon (process lifecycle)
```

## Targeting an environment

When you iterate on `apps/api`, you want CLI commands hitting your local server, not prod. The CLI reads `EPICENTER_API_URL` from the environment; named scripts wrap the two real workflows so the target is always explicit.

| I want to...                                          | I run...                                                               |
| ----------------------------------------------------- | ---------------------------------------------------------------------- |
| Develop against my local API server                   | `bun run cli:local auth login`                                         |
| Run from source against prod (rare: bug repro, demos) | `bun run cli auth login`                                               |
| Use the published binary (end user)                   | `epicenter auth login`                                                 |
| Override the target anywhere                          | `EPICENTER_API_URL=https://staging.example.com bun run cli auth login` |

Tokens are stored per API target so prod and local sessions coexist. Each target writes one file at `<dataDir>/auth/<host>.json`, where `<dataDir>` is the platform user-data directory from `env-paths('epicenter')` and `<host>` is the API host with `:` replaced by `_`. A fresh `cli:local auth login` will not overwrite your prod session. The daemon freezes its target at boot; to retarget, `daemon down` then `daemon up` again.

`EPICENTER_DATA_DIR=<path>` overrides `<dataDir>` itself (the user-data directory above; today the only user-global state stored there is cached credentials). Escape hatch for Nix, snap, ephemeral homes, and the test suite.

The same env var and scripts apply to every command that talks to the API, including `daemon`, not just `auth`.

## Commands

`epicenter daemon up` opens every mount listed in the project's `epicenter.config.ts`. `list`, `run`, and `peers` dispatch to that local daemon over its Unix socket.

```bash
epicenter auth login

epicenter daemon up -C ~/workspace
epicenter daemon ps
epicenter daemon logs -C ~/workspace
epicenter daemon down -C ~/workspace

epicenter list -C ~/workspace
epicenter list fuji.entries_update -C ~/workspace

epicenter run fuji.entries_update '{"id":"entry_1","tags":["triaged"]}' -C ~/workspace
epicenter run fuji.entries_update '{"id":"entry_1","tags":["triaged"]}' --peer user-1 -C ~/workspace

epicenter peers -C ~/workspace
```

`-C` is a start directory for project discovery. Discovery walks upward until it finds `epicenter.config.ts`, then the daemon starts every mount in that config.

## Exit codes

`run` is the only command with granular codes, so a script can branch on the failure kind:

| Code | `run` | `list`, `peers` |
| --- | --- | --- |
| `0` | success | success |
| `1` | usage error (unknown mount or action, action input that fails the action's schema, bad `--peer` input) or no daemon running | any failure (no daemon, bad arguments) |
| `2` | runtime error: the local action returned `Err`, or the remote RPC failed | (not used) |
| `3` | peer not found: `--peer <target>` did not resolve within `--wait` | (not used) |

`daemon up` exits `1` on startup failure (already running, bad config, auth) and `0` on clean shutdown. `daemon down`, `ps`, and `logs` exit `0`: a missing daemon or an empty log is reported, not treated as an error.

Error text goes to stderr; machine-readable output (`--format json|jsonl`, tables, and `run` results) goes to stdout.

## Project Mounts

`epicenter.config.ts` owns project discovery. The default export is a `Mount[]`. App packages ship mount factories that return `Mount` values; each `Mount.name` owns the CLI prefix.

```ts
import { fuji } from "@epicenter/fuji/project";

export default [fuji()];
```

The returned `Mount.name` is `fuji`, so the CLI addresses actions as `fuji.<action_key>` regardless of the project folder name.

For projects that host more than one mount, add more entries to the array:

```ts
import { fuji } from "@epicenter/fuji/project";
import { honeycrisp } from "@epicenter/honeycrisp/project";

export default [fuji(), honeycrisp()];
```

```
my-project/
├── epicenter.config.ts
└── .epicenter/
```

Writing a custom mount inline uses `defineMount` from `@epicenter/workspace/daemon`:

```ts
import { defineMount } from "@epicenter/workspace/daemon";

export default [
  defineMount({
    name: "notes",
    async open({
      keyring,
      openWebSocket,
      projectDir,
      mount,
      ownerId,
      deviceId,
      yDocClientId,
    }) {
      // Open the long-lived local runtime.
      // `mount` is the canonical mount name carried on the Mount object.
      // Return { collaboration, [Symbol.asyncDispose] }.
    },
  }),
];
```

`Mount.name` is the CLI prefix. Two mounts in one project must have distinct names; duplicates fail before any mount opens.

`.epicenter/` holds generated project data such as SQLite materializers, Yjs update logs, Markdown materializers, and its generated `.gitignore`. It is machine state, not the user-owned Markdown folder. Runtime files live outside the project: sockets and daemon metadata use the OS runtime directory, while daemon logs use the platform log directory from `env-paths`.

## Scripting

Use scripts for anything beyond one-shot CLI calls:

```ts
import { connectDaemonActions } from "@epicenter/workspace/node";
import type { FujiActions } from "@epicenter/fuji";

const fuji = await connectDaemonActions<FujiActions>({
  mount: "fuji",
});

await fuji.entries_update({ id, tags: ["triaged"] });
```

Scripts get normal TypeScript control flow. The CLI stays small: list, run, peers, and daemon lifecycle.

## Public API

```ts
import { createCLI } from "@epicenter/cli";
```
