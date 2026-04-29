# Workspace as daemon transport: collapse the script/CLI split

**Status**: ready for review (rev 2, rewritten 2026-04-28)
**Date**: 2026-04-28 (originally 2026-04-29)
**Revision note**: the prior revision of this spec assumed a `defineWorkspace` factory primitive that the package no longer ships. That primitive was deleted (specs `20260421T010000` and `20260421T170000`); apps now compose workspaces inline with `attach*` and a shared "open" helper (e.g. `openFuji()` in `apps/fuji/src/lib/fuji/index.ts`). This rewrite drops the factory framing, drops the `connectWorkspace(factory, { transport })` umbrella API, and lands the same architectural goal as a thinner layer on top of the current shape.
**Related**:
- `docs/architecture/workspace-process-topology.md` (the runtime architecture this spec implements)
- `20260428T140000-cli-mandatory-daemon-collapse.md` (immediate predecessor; made the daemon mandatory for CLI)
- `20260421T170000-collapse-document-and-workspace-primitives.md` (deleted `createWorkspace`; established manual composition as the workspace pattern)

## Why this exists

Today there are two execution models for workspace operations:

```
SCRIPTS (vault):                        CLI:
  import { fuji } from                    epicenter run/list/peers
    './epicenter.config'                  ├─ ping daemon
  in-process workspace                    └─ unix socket → daemon serves
  (own Y.Doc, own SQLite,
   own sync session, own
   materializer outputs)
```

When both run on the same `(absDir, workspaceId)` pair, two writers race on the SQLite WAL, the materializer directory, the cloud sync session, and the awareness clientID slot. Nothing in the system coordinates them. Two surfaces to maintain. Scripts pay daemon-style cold-start cost on every invocation (open Y.Doc, hydrate from SQLite, connect WebSocket, wait for first round-trip) only to throw the workspace away on exit.

This spec collapses the two: **the daemon hosts the workspace; scripts and the CLI are typed clients over a unix socket.** The daemon module moves from `@epicenter/cli` into `@epicenter/workspace` (where it belongs as a transport layer for the substrate it ships). Scripts and the CLI both call one new function, `connectDaemon`, to address a workspace by id.

After this spec lands:

- One front door for talking to a remote workspace: `connectDaemon<typeof openFuji>({ id })`.
- One wire contract: `defineMutation` and `defineQuery`.
- One persistence convention: `<absDir>/.epicenter/persistence/<workspaceId>.db`.
- Multi-folder is fine: same workspaceId in two folders means two replicas, syncing through the cloud.

The existing primitives (`attachTables`, `attachKv`, `attachEncryption`, `attachSync`, `defineMutation`, `defineQuery`) keep their shapes. The transport sits on top.

## The new mental model

```
@epicenter/workspace                              ← the substrate (today)
   ├── attach* primitives, define* schema         (unchanged)
   ├── daemon/                                    ← MOVED FROM @epicenter/cli
   │     ├── socketPathFor, pingDaemon, errors
   │     ├── createWorkspaceServer({ absDir, workspaces })
   │     └── daemonClient (typed RPC stubs)
   └── client/
         └── connectDaemon<typeof builder>({ id, absDir? })

@epicenter/cli                                    ← shell-shortcut layer
   ├── epicenter serve   → calls createWorkspaceServer
   └── run / list / peers → call connectDaemon

vault/epicenter.config.ts                         ← daemon's boot manifest
   ├── eagerly constructs each hosted workspace
   └── exports a `workspaces` array

vault/scripts/*.ts                                ← canonical scripting
   └── connectDaemon<typeof openFuji>({ id: 'epicenter.fuji' })
```

`connectDaemon` is the only RPC entry point. The CLI uses it. Scripts use it. Tests that want in-process don't use it: they call their workspace builder directly.

## Two patterns, one for each lifecycle

### Pattern 1 (canonical): scripts and CLI as daemon clients

```ts
// vault/scripts/tag-untagged.ts
import { connectDaemon } from '@epicenter/workspace';
import { openFuji } from '@epicenter/fuji/workspace';

using fuji = await connectDaemon<typeof openFuji>({ id: 'epicenter.fuji' });

const untagged = (await fuji.tables.entries.getAllValid())
  .filter(e => !e.deletedAt && e.tags.length === 0);

for (const entry of untagged) {
  await fuji.actions.entries.update({ id: entry.id, tags: ['untagged'] });
}
```

The `typeof openFuji` reference is type-only at the script's runtime: TypeScript reads `openFuji`'s return type to type the remote workspace, but the function body never executes in the script process. The script holds a unix socket and a typed RPC stub. No Y.Doc, no SQLite, no sync session.

### Pattern 2 (escape hatch): in-process with the builder

For tests, one-shot migrations, and standalone tools:

```ts
// tests/migration.test.ts
using fuji = openFuji({ auth, device });
await fuji.whenReady;
await fuji.tables.entries.set({ ... });
```

There is no `connectLocal`. In-process construction is `new`, not connection. Calling it `connectLocal` would be a lie; the call site says what it is.

The constraint: **no daemon may be running on the same `(absDir, workspaceId)` while a builder-constructed workspace is active.** SQLite file locking surfaces this if you try.

## Invariants

These are the lock-ins. All testable.

1. **`connectDaemon` is the only RPC entry to a workspace.** No alternative front door for remote.
2. **There is no transport discriminator.** Local mode is "call your builder." Remote mode is `connectDaemon(...)`. The asymmetry is deliberate: a single `transport: 'remote' | 'local'` API would paper over two operations that are nothing alike.
3. **The daemon module lives in `packages/workspace/src/daemon/`.** Not in `packages/cli`. The CLI imports it; vault scripts import it; tests import it.
4. **`defineMutation` and `defineQuery` are the only entries on the typed wire.** Tables auto-generate their CRUD via these. The daemon's wire surface is `/run` (typed dispatch). Built-in queries (`peers`, `list`) flow through the same `/run` route as `defineQuery` instances; there are no special routes.
5. **Per-workspace state is local under `<absDir>/.epicenter/`.** Persistence at `<absDir>/.epicenter/persistence/<id>.db`, materializer outputs alongside, daemon logs alongside.
6. **Per-user state stays global at `~/.epicenter/`.** Auth sessions, encryption keys derivation inputs, deviceId.
7. **Multiple daemons may run on the same machine for the same workspaceId in different folders.** Each is an independent replica. They reconcile through the cloud.
8. **`tables.X.filter(predicate)`, `tables.X.observe`, `documents.X.Y.open` throw `RemoteNotSupported` over the wire.** Available only by calling your builder directly.
9. **`createWorkspaceServer` is exported from `@epicenter/workspace`.** `epicenter serve` is a thin wrapper. Embedded use cases can call the function directly.
10. **The daemon owns auth.** Scripts pass no tokens. Filesystem permissions on the unix socket gate access.

## The eager config pattern

`vault/epicenter.config.ts` is the daemon's boot manifest, daemon-only by convention:

```ts
// vault/epicenter.config.ts
import { openFuji }       from '@epicenter/fuji/workspace';
import { openTabManager } from '@epicenter/tab-manager/workspace';
import { connectWorkspace } from '@epicenter/cli';
import { attachMarkdownMaterializer, attachSqliteMaterializer }
  from '@epicenter/workspace/extensions/materializer';

const absDir = import.meta.dir;

function bootFuji() {
  const doc = openFuji();
  const cloud = connectWorkspace({ ydoc: doc.ydoc, encryption: doc.encryption });
  const md  = attachMarkdownMaterializer(doc, { dir: 'fuji' });
  const sql = attachSqliteMaterializer(doc, { db: '.epicenter/materializer/fuji.db' });
  return Object.assign(doc, { cloud, md, sql, whenReady: cloud.whenReady });
}

function bootTabManager() {
  const doc = openTabManager();
  const cloud = connectWorkspace({ ydoc: doc.ydoc, encryption: doc.encryption });
  const md  = attachMarkdownMaterializer(doc, { dir: 'tab-manager' });
  return Object.assign(doc, { cloud, md, whenReady: cloud.whenReady });
}

export const fuji       = bootFuji();
export const tabManager = bootTabManager();

export const workspaces = [fuji, tabManager];
```

What this gives:

- Each shared "open" helper (`openFuji`, `openTabManager`) is the same code apps use in their own bootstraps. The function returns a Y.Doc plus tables/kv/encryption/actions and nothing else IO-shaped, so it composes equally well with browser IO (in apps), daemon IO (here), or no IO (tests).
- The local `bootFuji` / `bootTabManager` wrappers add the daemon-flavored IO: SQLite via `connectWorkspace` (the existing CLI bundle helper, kept as-is), materializers, anything else this folder wants. Those wrappers stay close to the config because they're vault-specific; nothing in `@epicenter/workspace` or `@epicenter/cli` needs to know about them.
- The `workspaces` array is the daemon's manifest. Each entry's id is `ws.ydoc.guid`. No separate id-to-constructor map; the workspace knows its own id.

Note that "today's `connectWorkspace`" (from `packages/cli/src/connect.ts`) is the daemon-side bundle helper that wires SQLite + session unlock + cloud sync. It is *not* the new front door. The new front door is `connectDaemon`. To avoid name collision, this spec does not delete or rename `cli/connect.ts`'s `connectWorkspace`; it stays as the bundle helper. (A later spec may rename it to something like `attachCloudChain` for clarity, but that is out of scope here.)

## What gets deleted, moved, and added

```
DELETED
  (none in @epicenter/cli — the prior front-door functions referenced by the
   pre-rev-1 version of this spec were already deleted by spec 170000)

MOVED   packages/cli/src/daemon/  →  packages/workspace/src/daemon/
  app.ts, client.ts, paths.ts, run-handler.ts, run-errors.ts,
  resolve-entry.ts, metadata.ts, unix-socket.ts (+ test files)

ADDED in packages/workspace/src/
  daemon/
    server.ts                  createWorkspaceServer(opts) → { listen, close }
    table-actions.ts           buildTableActions(tableDef) → auto-CRUD wrappers
  client/
    connect-daemon.ts          connectDaemon<typeof builder>(opts)
    remote.ts                  buildRemoteWorkspace(client, name)
    remote-not-supported.ts    RemoteNotSupported error type
  paths/
    persistence.ts             persistencePath(absDir, workspaceId)

ADDED in packages/cli/src/
  serve.ts                     thin wrapper around createWorkspaceServer

UPDATED
  packages/cli/src/commands/run.ts        ~451 → ~80 lines  (uses connectDaemon)
  packages/cli/src/commands/list.ts       ~554 → ~80 lines  (uses connectDaemon)
  packages/cli/src/commands/peers.ts      ~117 → ~50 lines  (uses connectDaemon)
  packages/cli/src/commands/up.ts         ~483 → ~120 lines (calls createWorkspaceServer)
  /Users/braden/Code/vault/epicenter.config.ts (rewritten as the eager manifest)
  /Users/braden/Code/vault/scripts/*.ts (use connectDaemon)
  /Users/braden/Code/vault/AGENTS.md (canonical pattern documented)
```

## Migration phases

These land in dependency order. Each phase compiles green and ships independently.

### Phase 1: move daemon module into `@epicenter/workspace`

> Done 2026-04-28: moved 8 modules + 6 test files via `git mv`; added a `daemon/types.ts` (`LoadedWorkspace`, `WorkspaceEntry`) so `@epicenter/cli`'s `load-config.ts` re-exports from the workspace package; re-exported the daemon surface from `packages/workspace/src/index.ts`; CLI commands (`run`, `list`, `peers`, `serve`, `serve.test`) now import from `@epicenter/workspace`. Workspace package picked up `hono` and `@hono/standard-validator` deps. All 28 daemon tests green; pre-existing test failures unrelated.

Mechanical relocation. No behavior change.

```
packages/cli/src/daemon/  →  packages/workspace/src/daemon/
```

Re-export from `packages/workspace/src/index.ts`:

```ts
export {
  socketPathFor,
  pingDaemon,
  daemonClient,
  type DaemonClient,
  DaemonError,
} from './daemon/index.js';
```

Update `packages/cli/src/commands/{run,list,peers,up}.ts` imports to point at `@epicenter/workspace` instead of `../daemon`. Delete the now-empty `packages/cli/src/daemon/` directory.

CLI behavior is unchanged. Tests pass without modification beyond import paths.

### Phase 2: introduce `createWorkspaceServer`

> Done 2026-04-28: added `packages/workspace/src/daemon/server.ts` exposing `createWorkspaceServer({ absDir, workspaces }) -> { socketPath, listen, close }`. The factory builds the Hono app via `buildApp` and binds via `bindOrRecover` (stale-socket sweep preserved). Re-exported from `@epicenter/workspace`. `packages/cli/src/commands/serve.ts` now drops its inline `bindOrRecover` + `socketPathFor` + `unlinkSocketFile` calls and delegates to the factory; the lifecycle (config load, metadata write/unlink, `whenReady` gating, signal handlers, log routing, dispose orchestration) stays in `runServe`. Pragmatic deviation from the spec sketch: `workspaces` is `WorkspaceEntry[]` (the `{ name, workspace }` shape `buildApp` already accepts) rather than a bare `Workspace[]` keyed by `ws.ydoc.guid`. Keying by `ydoc.guid` would have churned the wire selector (`-w <name>`) and the route validators in this phase; deferred to a later spec when the wire moves to id-based dispatch. CLI typecheck clean, workspace typecheck clean, daemon tests 28/28 pass, CLI tests show only the pre-existing `cli.test.ts` yargs-message failure.

Extract daemon startup from `up.ts` into a server factory:

```ts
// packages/workspace/src/daemon/server.ts
export function createWorkspaceServer(opts: {
  absDir: string;
  workspaces: Workspace[];   // pre-constructed; the eager config pattern
}): {
  listen(): Promise<void>;
  close(): Promise<void>;
};
```

Internally, `createWorkspaceServer` builds a `Map<workspaceId, Workspace>` keyed by `ws.ydoc.guid`, binds the unix socket, and dispatches `/run` requests by routing on the workspace id in the request body.

`packages/cli/src/commands/up.ts` becomes a thin shell: load config, call `createWorkspaceServer`, install signal handlers, exit cleanly. Lifecycle (metadata write, log routing, process supervision) stays in the CLI; the "build the workspace + bind the socket" core moves to the workspace package.

### Phase 3: switch persistence path to local

Add `paths/persistence.ts`:

```ts
// packages/workspace/src/paths/persistence.ts
import { join } from 'node:path';
export function persistencePath(absDir: string, workspaceId: string): string {
  return join(absDir, '.epicenter', 'persistence', `${workspaceId}.db`);
}
```

Update `packages/cli/src/connect.ts`'s `epicenterPaths.persistence(workspaceId)` default to take an `absDir` argument instead of resolving against `~/.epicenter/`. Update vault's wrappers to pass `absDir`. Update test fixtures.

Provide a one-time migration script at `packages/cli/scripts/migrate-persistence-to-local.ts`:

```bash
$ bun x epicenter migrate-persistence
moving ~/.epicenter/persistence/epicenter.fuji.db
   to /Users/braden/Code/vault/.epicenter/persistence/epicenter.fuji.db ...
```

The script reads each `~/.epicenter/persistence/<id>.db`, asks the user which absDir owns it (or accepts `--from <id> --to <absDir>` flags), moves the file, removes the global one. If a workspaceId has no clear single owner (multiple configs declare it), errors and tells the user to do it manually.

The Phase 3 cutover is gated on this script existing and being documented. Users who upgrade without running it lose access to existing persistence until they do; that is acceptable but must be flagged in release notes.

### Phase 4: auto-generate table action wrappers

Add `daemon/table-actions.ts`:

```ts
// Walks a TableDefinition and produces the auto-generated CRUD action set.
export function buildTableActions<T extends TableDefinition>(
  table: T,
  tableName: string,
) {
  return {
    get: defineQuery({
      title: `Get ${tableName}`,
      input: type({ id: 'string' }),
      handler: ({ id }) => table.get(id),
    }),
    getAllValid: defineQuery({
      title: `Get all ${tableName}`,
      input: type({}),
      handler: () => table.getAllValid(),
    }),
    set: defineMutation({
      title: `Set ${tableName}`,
      input: table.schema,
      handler: (row) => table.set(row),
    }),
    update: defineMutation({
      title: `Update ${tableName}`,
      input: partialOf(table.schema, { keep: ['id'] }),
      handler: ({ id, ...patch }) => table.update(id, patch),
    }),
    delete: defineMutation({
      title: `Delete ${tableName}`,
      input: type({ id: 'string' }),
      handler: ({ id }) => table.delete(id),
    }),
    bulkSet: defineMutation({
      title: `Bulk set ${tableName}`,
      input: type({ rows: table.schema.array() }),
      handler: ({ rows }) => table.bulkSet(rows),
    }),
  };
}
```

`partialOf` is the schema combinator that produces `{ id } & Partial<RowExceptId>`. **Spike before committing to this phase.** Verify that arktype's `.partial()` composes cleanly with branded types like `EntryId = string & Brand<'EntryId'>`. Required behavior:

- Accepts `{ id, title }`, `{ id, tags }`, and `{ id }` alone.
- Rejects `{ id, _v: 99 }` and `{ title: 'no id' }`.
- The TypeScript inferred type is `{ id: EntryId, title?: string, ... }` with brand preserved.

If `.partial()` works directly, use it. If brand erosion happens, write a custom walker in `packages/workspace/src/shared/schema-partial.ts` and unit-test it before this phase proceeds.

The auto-generated actions plug onto the workspace's bundle in `bootFuji` (vault-side):

```ts
const fujiTables = doc.tables;
const fujiTableActions = {
  entries: buildTableActions(fujiTables.entries, 'entries'),
};
return Object.assign(doc, {
  /* ... */,
  actions: { ...doc.actions, tables: fujiTableActions },
});
```

so `fuji.actions.tables.entries.update` is callable both in-process and over RPC.

### Phase 5: build the remote workspace

```ts
// packages/workspace/src/client/remote.ts
export function buildRemoteWorkspace<T>(
  client: DaemonClient,
  workspaceId: string,
): RemoteWorkspace<T> {
  // Walks the inferred type T's manifest at compile time;
  // each method becomes a one-line RPC call at runtime.
  return {
    tables: buildRemoteTables(client, workspaceId),
    actions: buildRemoteActions(client, workspaceId),
    sync: { peers: () => client.run(workspaceId, 'sync.peers', {}) },
    whenReady: client.ping(),
    [Symbol.dispose]: () => client.close(),
    // filter / observe / documents.open throw RemoteNotSupported
  };
}
```

`RemoteWorkspace<T>` is a mapped type that takes the in-process workspace's typed shape and rewrites table operations and action handlers into RPC calls that return `Promise<Result<...>>`.

### Phase 6: add `connectDaemon`

```ts
// packages/workspace/src/client/connect-daemon.ts
export async function connectDaemon<T extends (...args: any[]) => any>(
  opts: {
    id: string;
    absDir?: string;  // optional; defaults to upward search for .epicenter/
  },
): Promise<RemoteWorkspace<ReturnType<T>>> {
  const absDir = opts.absDir ?? findEpicenterDir(process.cwd());
  const sock   = socketPathFor(absDir);
  if (!(await pingDaemon(sock))) {
    throw DaemonError.Required({ absDir, id: opts.id });
  }
  return buildRemoteWorkspace<ReturnType<T>>(daemonClient(sock), opts.id);
}
```

`findEpicenterDir` walks parent directories from `process.cwd()` looking for `epicenter.config.ts` (or a `.epicenter/` directory). Errors clearly if not found.

Generic call shape for the user:

```ts
import { openFuji } from '@epicenter/fuji/workspace';

using fuji = await connectDaemon<typeof openFuji>({ id: 'epicenter.fuji' });
//                                ^^^^^^^^^^^^^^^^
//                                  type-only; body never runs
```

### Phase 7: rewrite CLI command handlers

Each `run`/`list`/`peers` handler becomes a 5-liner that uses `connectDaemon`. The CLI no longer owns daemon dispatch; it owns argv parsing and output formatting. Net deletion ~600 lines across these four files.

For typing, the CLI doesn't have a single workspace builder to reference (it serves whatever the user's config exports). The CLI uses a less specific generic on `connectDaemon`, accepts the runtime workspace id, and renders results without strict typing on the action shape:

```ts
// peers handler (sketch)
const ws = await connectDaemon({ id: argv.workspaceId });
const rows = await ws.sync.peers();
emit(rows);
```

That looser typing is acceptable because the CLI's job is rendering, not composition. Vault scripts get full types; the CLI gets correctness via runtime validation.

### Phase 8: rewrite vault

Vault's `epicenter.config.ts` is rewritten as the eager manifest above. Vault's scripts use `connectDaemon`. Vault's `AGENTS.md` is updated to document the canonical pattern (daemon + remote scripts) and the escape hatch (call your builder directly when you genuinely need in-process).

Vault and the workspace package land in lockstep: stage the monorepo change, run `bun install` in vault to pick up the link: dep, fix vault, then commit the monorepo and vault changes. There is at least one transient state where vault's previous config does not compile against the new package; that state is acceptable as long as no other consumer is mid-rebuild.

Audit before this phase: identify any vault script that uses `documents.X.Y.open(id)` or `tables.X.observe`. Each such script either rewrites as an action (preferred), uses the in-process escape hatch, or remains broken-and-flagged until reworked.

### Phase 9: verification

- `bun test` in `packages/workspace`, `packages/cli`. Pass.
- `bun run typecheck` in `apps/fuji`, `apps/whispering`, `apps/dashboard`. Clean.
- `bun run build` at repo root. Clean.
- Manual smoke 1: in vault, `epicenter serve &`, `bun run scripts/tag-untagged.ts`. Verify writes appear in the daemon's materializer output.
- Manual smoke 2: kill daemon, `bun run scripts/tag-untagged.ts` should error with `DaemonError.Required` and an `epicenter serve` hint.
- Manual smoke 3: in two folders with the same workspaceId, run `epicenter serve` in both. Both daemons stay alive (separate SQLite locks). Both appear as peers in the cloud.
- Grep `EPICENTER_PATHS.persistence` outside legacy migration code: zero results.
- Grep `import.*from.*['"]@epicenter/cli.*daemon`: zero results (daemon module exported from `@epicenter/workspace`).

## Edge cases

### Daemon and an in-process builder on the same `(absDir, workspaceId)`

SQLite file locking on `<absDir>/.epicenter/persistence/<id>.db` enforces single-writer. Whichever process opens first holds the WAL lock; the second fails with a clear OS-level error. Surface it cleanly:

```
SQLITE_BUSY: database is locked at
  /Users/braden/Code/vault/.epicenter/persistence/epicenter.fuji.db
A daemon is likely already running for this workspace.
Stop it with `epicenter stop` or use connectDaemon instead.
```

No coordination machinery; surface the lock error with a hint.

### Same workspaceId, different folders, same machine

Each folder has its own `<absDir>/.epicenter/persistence/<id>.db`. Different lock files, no conflict. From the cloud's perspective, two clients with the same deviceId, different clientIDs. They show up as two peers, ideally distinguished by `deviceName`.

### Wire-protocol drift between daemon and script

`@hono/standard-validator` returns a typed 400 if the script sends a body the daemon's schema does not recognize. The script's RPC client folds this into `DaemonError.HandlerCrashed` (or a new `WireSchemaMismatch` variant; decided in implementation). The user sees a clean error with a hint about version mismatch. v1 does not enforce strict version-checking; it surfaces drift when it bites.

### In-process builder in test fixtures

Tests call the workspace builder directly with a tmpdir as `absDir`:

```ts
using fuji = openFuji({ ... });  // or a vault-shaped boot wrapper that points at tmpdir
```

No daemon involvement, no cross-test contamination. Cleanup is `rmSync(tmpdir, { recursive: true })`.

### Migration of existing `~/.epicenter/persistence/<id>.db` files

The `migrate-persistence-to-local` script handles the one-time move. Document the upgrade step in vault's release notes. After the script runs, the global persistence directory should contain only `auth/sessions.json` and any device-id state.

### Power users who want global persistence back

Provide an env var override: `EPICENTER_PERSISTENCE_DIR=/some/global/path` redirects the persistence path. Default behavior is local; the override is for unusual deployments (containerized, network filesystem). Document but do not surface prominently.

## Risks and mitigations

**Risk: vault users on existing global persistence break on upgrade.**
Mitigation: ship `migrate-persistence-to-local` script. Document the upgrade. Consider a major version bump on `@epicenter/workspace` so the change is visible.

**Risk: `partialOf` schema combinator harder to express than expected.**
Mitigation: spike before committing to Phase 4. If arktype's `.partial()` does not preserve brands, build a minimal helper in `packages/workspace/src/shared/schema-partial.ts`. Worst case: a custom walker over the schema's record shape.

**Risk: deleting old code paths breaks vault before scripts are updated.**
Mitigation: Phase 8 lands the deletion *and* the vault rewrite together. Do not ship interim states where vault references a deleted symbol.

**Risk: `RemoteNotSupported` for `documents.open` blocks a real vault use case.**
Mitigation: identify which vault scripts (if any) use document handles before Phase 8. Rewrite as actions where possible; otherwise use the in-process builder for those scripts specifically. Document the constraint in vault's AGENTS.md.

**Risk: typing `connectDaemon` for the CLI loses the typed-end-to-end story.**
Mitigation: accept it. The CLI renders rather than composes. Scripts, the typed-RPC consumers, get full types via `<typeof openFuji>`.

## Out of scope

- **Auto-spawn / `transport: 'auto'`.** Decided against. Daemon is started explicitly with `epicenter serve`.
- **Streaming `observe` over the unix socket.** Defer. Throws `RemoteNotSupported` in v1.
- **Document handles over RPC.** Probably never; use the in-process builder if needed.
- **Hot reload of `epicenter.config.ts`.** Restart the daemon on config changes.
- **Per-folder device identity.** `deviceId` stays global. Use `deviceName` for presentation.
- **Renaming `cli/connect.ts`'s `connectWorkspace` to `attachCloudChain`.** Out of scope; that's a clarity refactor, not a transport change.

## Success criteria

1. `connectDaemon(opts)` is the only documented way to talk to a remote workspace from any bun process.
2. `defineMutation` and `defineQuery` are the only mechanisms that put something on the typed wire.
3. Vault scripts and CLI commands have the same shape: `connectDaemon`, do work, dispose.
4. Two folders with the same workspaceId can run daemons simultaneously without conflict.
5. The `packages/cli/src/daemon/` directory is gone; `packages/workspace/src/daemon/` owns the transport.
6. Net code deletion across `packages/cli` is at least 500 lines.
7. `~/.epicenter/persistence/` is no longer referenced outside the migration script.
8. `createWorkspaceServer` is callable from any bun process (CLI, vault, embedded).
