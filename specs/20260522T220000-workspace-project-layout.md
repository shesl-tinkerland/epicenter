# Workspace project layout: `epicenter.config.ts`, markdown as canon, `~/.epicenter/`

Status: draft
Owner: braden
Date: 2026-05-22

Current code note (2026-05-27): the default direction in this spec still
matches current code: a project can default-export `defineWorkspace({ open })`
from `epicenter.config.ts`. The strong "no more daemon.routes" language below
is too absolute. `defineConfig({ daemon: { routes: { ... } } })` remains the
multi-route escape hatch, and `workspaces/` remains a source-layout convention
only.

## 1. Goal

Pin down the on-disk layout for any Epicenter-using project so that:

- A developer cloning a project can identify it as Epicenter at a glance.
- A daemon, a CLI, and a Tauri app on the same machine all read and write the same shared user state without coordination via env vars.
- Markdown is the canonical, human-editable, git-friendly representation of workspace data. Yjs is the runtime collaboration layer; SQLite is a queryable mirror.
- One workspace per project. Multi-workspace is a monorepo, not a directory-of-workspaces.
- The platform reserves two things in a project tree, and one in the user's home. Nothing else.

This spec replaces ad-hoc usage of `env-paths`, the `<projectDir>/.epicenter/<resource>/<wsId>` per-resource layout, and the assumption that yjs.db is the committed source of truth.

## 2. The reservations

```
At a project root:
  epicenter.config.ts             ← FILE, required. Marker + workspace definition.
  .epicenter/                     ← DIR, runtime cache. Auto-created. Gitignored.

In user home:
  ~/.epicenter/                   ← DIR, cross-app user state. Auto-created.
```

That's it. No `workspaces/` container. No `workspace.ts` companion file. No `<route>/` subdirectories. One workspace per project; the file at root defines it.

By convention, table data lives in directories at the project root named after the table:

```
<project>/<tableName>/<slug>.md
```

This is convention, not reservation. The actual paths are whatever the developer passes to the markdown materializer in `epicenter.config.ts`. The spec documents the default; the materializer accepts any path.

### 2.1 What each reservation is

`epicenter.config.ts` is the *identity* and *definition* of an Epicenter project. `findProjectRoot()` walks up from `process.cwd()` looking for this exact filename. It also default-exports the daemon definition: schema, materializer attachments, sync setup, all inline. Marker and definition collapse into one file because there is one workspace per project.

`<project>/.epicenter/` is *project-local runtime cache*. The Yjs persistence file, the SQLite materializer mirror, the WAL sidecars. Gitignored. Regenerable. Analogous to `.next/`, `.svelte-kit/`, `.turbo/` for other tools.

`~/.epicenter/` is *user-and-machine-scoped shared state*. Auth tokens (or a keychain fallback pointer), local device identity, settings shared across Epicenter apps on this machine, logs, schema version stamp. Same absolute path on macOS, Linux, and Windows: `${homedir()}/.epicenter/`. One rule.

### 2.2 What this changes from the previous draft and from current code

```
Concept                       Previous draft               This spec
-------                       --------------               ---------
Project marker                epicenter.config.ts          epicenter.config.ts
                              (just a registry)            (registry AND workspace definition)

Workspaces per project        many                         one
                              (under workspaces/<r>/)      (project = workspace)

Per-workspace definition      workspaces/<r>/workspace.ts  inline in epicenter.config.ts

Source of truth in git        workspaces/<r>/yjs.db        committed markdown (./<tableName>/*.md)

Local runtime cache           workspaces/<r>/sqlite.db     .epicenter/sqlite.db
                              workspaces/<r>/yjs.db        .epicenter/yjs.db (NOT committed)
                              workspaces/<r>/md/           (markdown lives at project root)

Multi-workspace               daemon.routes registry       monorepo: sibling projects

Daemon route concept          required                     vestigial (one workspace = no route prefix)
```

The deepest shift is the source-of-truth inversion. Today, yjs.db is canonical and markdown is derived. This spec makes markdown canonical and yjs.db a regenerable runtime cache. See §7 for the architectural consequences.

## 3. `~/.epicenter/` (user-level shared state)

### 3.1 Path resolution

```ts
// packages/constants/src/platform-paths.ts
import { homedir } from 'node:os';
import { join } from 'node:path';

const root = process.env.EPICENTER_HOME ?? join(homedir(), '.epicenter');

export const platformPaths = {
  root,
  authDir:     join(root, 'auth'),
  identityDir: join(root, 'identity'),
  logsDir:     join(root, 'logs'),
  cacheDir:    join(root, 'cache'),
  settingsFile: join(root, 'settings.json'),
  versionFile: join(root, 'version.json'),
} as const;
```

```rust
// Tauri Rust counterpart
pub fn root() -> PathBuf {
    std::env::var("EPICENTER_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| dirs::home_dir().expect("home dir").join(".epicenter"))
}
```

Identical absolute paths because the formula is `home_dir() + ".epicenter"`. No platform branching. `EPICENTER_HOME` overrides for CI and tests.

### 3.2 Tree

```
~/.epicenter/
├── version.json              ← { "schemaVersion": 1 }; gate for forward compat
├── settings.json             ← cross-app user prefs (theme, etc.); not auth
├── auth/
│   └── <host>.json           ← fallback when OS keychain is unavailable
│                               mode 0600, atomic rename writes
├── identity/
│   └── local-identity.json   ← device key material (per-machine, not per-app)
├── logs/
│   └── <projectHash>/        ← dirHash(projectDir) for namespacing
│       └── daemon.log
└── cache/                    ← free-form: download caches, model weights, etc.
```

`<projectHash>` is the existing 64-bit SHA256 prefix from `packages/workspace/src/daemon/paths.ts`, already used to key daemon socket/meta/lease files in `$XDG_RUNTIME_DIR/epicenter/`. Logs follow the same scheme for symmetry.

### 3.3 Secrets policy

Auth tokens prefer OS keychain when available:

```
macOS    Keychain.app via tauri-plugin-stronghold (desktop) or `keyring` crate (CLI)
Windows  Credential Manager via the same crate
Linux    libsecret if available; file fallback otherwise
```

`~/.epicenter/auth/<host>.json` is the file fallback (mode 0600 on Unix, atomic rename writes, host name in filename). Separate workstream from this spec; referenced for completeness.

### 3.4 Schema versioning

```json
{
  "schemaVersion": 1,
  "writers": [
    { "process": "cli", "version": "0.4.0", "lastSeen": "2026-05-22T22:00:00Z" }
  ]
}
```

Every Epicenter process reads `version.json` on startup. If `schemaVersion > knownVersion`, the process refuses to write and prints a clear "your CLI is older than this directory" message.

## 4. `epicenter.config.ts` (the marker and the definition)

### 4.1 The contract

- Exact filename: `epicenter.config.ts`. Resolved by `PROJECT_CONFIG_FILENAME` in `packages/workspace/src/config/define-config.ts`.
- Default-exports a `defineWorkspace({...})` (or equivalent) call that returns a `DaemonWorkspaceDefinition`.
- Lives at the project root.
- It is the only file that makes a directory an Epicenter project.
- Defines the schema, attaches materializers, and configures sync. All inline. No separate config + workspace files.

### 4.2 Shape

The file composes a daemon. The composition produces (a) a workspace's schema, (b) materializer attachments with explicit paths, (c) sync infrastructure setup.

```ts
// epicenter.config.ts (canonical shape)
import { defineWorkspace } from '@epicenter/workspace';
import {
  attachDaemonInfrastructure,
  openWriterSqlite,
} from '@epicenter/workspace/node';
import { attachSqliteMaterializer } from '@epicenter/workspace/document/materializer/sqlite';
import {
  attachMarkdownMaterializer,
  slugFilename,
} from '@epicenter/workspace/document/materializer/markdown';
import { attachTables, defineTable } from '@epicenter/workspace';
import { type } from 'arktype';
import * as Y from 'yjs';
import { createLogger } from 'wellcrafted/logger';

const WORKSPACE_GUID = 'epicenter.fuji';

const Entry = defineTable(type({
  id: 'string',
  title: 'string',
  body: 'string',
}));

export default defineWorkspace({
  guid: WORKSPACE_GUID,

  async open({ projectDir, openWebSocket, installationId }) {
    const ydoc = new Y.Doc({ guid: WORKSPACE_GUID });
    const tables = attachTables(ydoc, { entries: Entry });

    const infra = attachDaemonInfrastructure(ydoc, {
      projectDir,
      openWebSocket,
      installationId,
      actions: { /* queries, mutations */ },
    });

    // Materializer paths are explicit and relative to projectDir.
    // The developer chooses where outputs land.
    const sqliteDb = openWriterSqlite({
      filePath: join(projectDir, '.epicenter', 'sqlite.db'),
      log: createLogger('sqlite'),
    });
    ydoc.once('destroy', () => sqliteDb.close());

    attachSqliteMaterializer(ydoc, { db: sqliteDb }).table(tables.entries);

    // The markdown materializer appends `table.name` (or a per-table `dir`
    // override) to its base `dir`. Passing `dir: projectDir` produces
    // `<projectDir>/entries/<slug>.md` for the `entries` table.
    attachMarkdownMaterializer(ydoc, {
      dir: projectDir,
    }).table(tables.entries, { filename: slugFilename('title') });

    return infra;
  },
});
```

Three things to notice:

1. **No route concept at the disk layer.** One workspace per project; the daemon serves one set of RPCs; no `route.<name>` prefix needed in path computation. (The wire-protocol may keep a route name for compatibility; that's a separate concern.)
2. **Materializer paths are explicit.** `dir: join(projectDir, 'entries')` says where the markdown goes. There is no implicit "table name becomes directory name" magic; the developer writes it. The convention is just what the example does.
3. **Yjs.db lives under `.epicenter/`.** That's the developer's choice in the `openWriterSqlite` call. Convention: hidden runtime state under `.epicenter/`.

### 4.3 Project-side helpers

To avoid every project repeating `join(projectDir, '.epicenter', 'sqlite.db')`, the workspace package exposes two path helpers:

```ts
// packages/workspace/src/document/project-paths.ts
import { join } from 'node:path';

const HIDDEN_DIR = '.epicenter';

export function epicenterCacheDir(projectDir: string): string {
  return join(projectDir, HIDDEN_DIR);
}

export function yjsPath(projectDir: string): string {
  return join(epicenterCacheDir(projectDir), 'yjs.db');
}

export function sqlitePath(projectDir: string): string {
  return join(epicenterCacheDir(projectDir), 'sqlite.db');
}
```

There is no `tableMarkdownDir` helper. The markdown materializer's `dir` is its *base*, and the table name is auto-appended (or overridable per-table via `.table(t, { dir: 'custom' })`). To put tables at the project root, pass `projectDir` directly:

```ts
import { sqlitePath } from '@epicenter/workspace/node';

// ...
const sqliteDb = openWriterSqlite({
  filePath: sqlitePath(projectDir),
  log: createLogger('sqlite'),
});

// Table `entries` lands at <projectDir>/entries/<slug>.md (table name appended).
attachMarkdownMaterializer(ydoc, { dir: projectDir })
  .table(tables.entries, { filename: slugFilename('title') });

// Or to nest under data/: <projectDir>/data/entries/<slug>.md
attachMarkdownMaterializer(ydoc, { dir: join(projectDir, 'data') })
  .table(tables.entries, { filename: slugFilename('title') });

// Or to put one table at a non-conventional path:
attachMarkdownMaterializer(ydoc, { dir: projectDir })
  .table(tables.entries, { dir: 'notes', filename: slugFilename('title') });
// → <projectDir>/notes/<slug>.md
```

Helpers exist for the paths that always look the same (`.epicenter/yjs.db`, `.epicenter/sqlite.db`). Markdown paths are left as direct `dir:` arguments because the developer's intent (root vs nested vs per-table override) is a choice, not a convention.

### 4.4 No more `daemon.routes` registry

Today `defineConfig({ daemon: { routes: { fuji } } })` registers many routes under one project. With one workspace per project, the registry has nothing to register. `defineWorkspace({...})` returns the workspace definition directly.

The existing `defineConfig` API is renamed to `defineWorkspace` to match the new semantics. Backwards compatibility is documented in §11.

## 5. Project layout (one workspace, flat)

### 5.1 Canonical tree

```
<project>/
├── package.json                         ← bun init writes this
├── tsconfig.json                        ← bun init writes this
├── README.md                            ← bun init writes this
├── epicenter.config.ts                  ← REQUIRED. Marker + definition.
├── .gitignore                           ← Epicenter-managed; one rule (`.epicenter/`)
├── entries/                             ← table data as markdown (committable)
│   ├── welcome.md
│   └── hello-fuji.md
├── (other table directories)/           ← if the workspace has multiple tables
└── .epicenter/                          ← runtime cache; gitignored
    ├── yjs.db                           ← Yjs persistence (regenerable)
    ├── yjs.db-wal
    ├── yjs.db-shm
    ├── sqlite.db                        ← SQL materializer (regenerable)
    ├── sqlite.db-wal
    └── sqlite.db-shm
```

### 5.2 What's at the project root

Everything visible at the project root is either user code (`package.json`, `tsconfig.json`, source files), Epicenter's marker (`epicenter.config.ts`), or the workspace's committed data (`entries/`, `tasks/`, etc.).

The hidden `.epicenter/` directory holds everything regenerable. It is created lazily by the daemon on first run.

### 5.3 What's a "table directory"

A table directory is the markdown materializer's output for one table. Its path is:

```
<materializer.dir>/<table.name>/<filename>.md
```

where:
- `materializer.dir` is the base argument passed to `attachMarkdownMaterializer({ dir })`.
- `table.name` is the table's name, auto-appended by the materializer. Overridable per-table via `.table(t, { dir: 'custom' })`.
- `filename` comes from the per-table `filename` strategy (default: slug from `id`; commonly `slugFilename('title')`).

Default convention: `dir: projectDir`, no per-table override. Files land at `<projectDir>/<table.name>/<slug>.md`. For the `entries` table, that's `<projectDir>/entries/<slug>.md`.

For workspaces with multiple tables:

```
<project>/
├── epicenter.config.ts
├── entries/                     ← table 1
│   ├── welcome.md
│   └── hello-fuji.md
├── tags/                        ← table 2
│   └── work.md
├── projects/                    ← table 3
│   ├── alpha.md
│   └── beta.md
└── .epicenter/
```

Each table = one top-level directory. If a table name collides with a directory the developer needs for other purposes, they pick a different table name or pass a custom `dir` to the materializer (e.g., `./data/entries`).

### 5.4 Collision handling

Table names collide with directories like `src/`, `tests/`, `docs/`, `node_modules/` in principle. In practice this is a developer choice: they name their tables, and they avoid names that collide. Sensible table names (`entries`, `notes`, `tasks`, `journal`, `quotes`) don't collide with typical project structure.

For projects that want explicit isolation:

```
<project>/
├── epicenter.config.ts
├── data/                        ← chosen explicit prefix
│   ├── entries/
│   └── tags/
└── .epicenter/
```

Achieved by passing `dir: join(projectDir, 'data')` to the materializer. Both tables still get their `<table.name>` subdirectory appended. The spec does not enforce nesting; it enables it.

## 6. The `.gitignore` standard

### 6.1 Location and content

`<project>/.gitignore`. Written by `epicenter init`. Augments whatever the developer already has (does not overwrite).

```gitignore
# Epicenter: all durable runtime state and materializer caches.
# Regenerable from committed markdown in table directories.
.epicenter/
```

That's it. One rule. The hidden directory holds everything Epicenter wants gitignored.

### 6.2 Why this works

- `.epicenter/` contains `yjs.db`, `sqlite.db`, and their WAL sidecars. All hidden, all ignored.
- Markdown lives at the project root (`entries/`, `tasks/`, etc.). Visible. Committed by default because it's not ignored.
- The developer can choose to ignore specific table directories if they don't want them in git:

```gitignore
.epicenter/

# Optional: don't commit markdown for a private table
private-notes/
```

- No `*` glob patterns required. Direct paths only.

### 6.3 What `epicenter init` does to the gitignore

If `<project>/.gitignore` doesn't exist: create with just the Epicenter rule.

If it exists: append the Epicenter rule if not already present, with a comment marking it as Epicenter-managed:

```gitignore
# (existing user content unchanged)

# Epicenter
.epicenter/
```

Idempotent: re-running `epicenter init` after init does not duplicate the rule.

### 6.4 Optional commit of materializer caches

If a developer wants to commit `sqlite.db` (e.g., to ship a precomputed query database with the repo), they comment out `.epicenter/` and add specific paths:

```gitignore
# Epicenter: keep sqlite, ignore yjs and WAL
.epicenter/yjs.db
.epicenter/yjs.db-wal
.epicenter/yjs.db-shm
.epicenter/sqlite.db-wal
.epicenter/sqlite.db-shm
```

This is an explicit choice; the default is gitignore everything in `.epicenter/`.

## 7. Markdown as the source of truth

### 7.1 The architectural shift

```
Today:                              This spec:
yjs.db = source of truth            ./<tableName>/*.md = source of truth (in git)
md/ = derived from yjs.db           .epicenter/yjs.db = derived from markdown
                                    (runtime cache; rebuilt on demand)
```

Git becomes the merge surface. Two peers can edit `entries/welcome.md` independently, push, merge, and git's line-based merge does the work. No binary conflicts on yjs.db because yjs.db isn't in git.

### 7.2 What this requires (dependency on future work)

The current implementation writes one-way: `Y.Doc → markdown`. The reverse direction (`markdown → Y.Doc`) does not exist.

To make markdown canonical, three pieces of plumbing are needed:

1. **Hydration**: on daemon start, read markdown files, parse front-matter + body, populate the Y.Doc. If `.epicenter/yjs.db` exists and is consistent with the markdown, skip the rehydration; otherwise rebuild.
2. **Reverse watcher**: when a markdown file changes outside the daemon (via editor, git pull, etc.), the daemon picks it up and applies a Y.Doc update.
3. **Round-trip fidelity**: serialization must round-trip without loss. Markdown front-matter holds non-body fields; the body is the markdown. Yjs CRDT properties (character-level merging) are sacrificed at the markdown layer.

These three are out of scope for this layout spec but assumed as the architectural target. The layout works without them (yjs.db is just gitignored runtime state), but the full architectural payoff requires them.

### 7.3 Single-peer vs multi-peer behavior

```
Single peer:
  - One yjs.db in .epicenter/, one set of markdown files.
  - Edit via daemon → Y.Doc → markdown.
  - Edit markdown directly → daemon picks up via reverse watcher → Y.Doc.
  - Either path produces the same state.

Multi-peer (real-time):
  - Sync server replicates Y.Doc updates across peers.
  - Each peer materializes markdown locally.
  - No git involvement.

Multi-peer (async, via git):
  - Each peer edits markdown, commits, pushes.
  - Pulling reapplies markdown changes locally.
  - Daemon's reverse watcher rehydrates Y.Doc from the new markdown.
  - Conflicts: git's line-based merge resolves them at the markdown layer.
```

### 7.4 Why yjs.db is no longer committed

```
Reasons:
  - Binary; git can't auto-merge.
  - Append-only growing log; bloats the repo.
  - Regenerable from markdown (after §7.2 lands).
  - The sync server is the canonical multi-peer truth; git is for content, not state.

Consequence: workspaces ship via markdown. A clone gets entries/*.md.
The daemon rebuilds .epicenter/yjs.db on first run.
```

## 8. WAL safety

Less load-bearing now that yjs.db isn't committed. Still relevant for two cases:

1. **Backup**: if a user backs up `.epicenter/yjs.db` (e.g., via Time Machine, rsync), the backup should be consistent. Stop the daemon or run `epicenter checkpoint` before backup.
2. **Manual inspection**: opening `.epicenter/yjs.db` with `sqlite3` while the daemon is running may show stale state. Stop the daemon first.

`epicenter checkpoint` (new CLI subcommand, separate work) runs `PRAGMA wal_checkpoint(TRUNCATE)` on `yjs.db` and `sqlite.db`. Optional pre-backup hook recipe documented but not auto-installed.

## 9. CLI resolution: walk up, then scan one level down

```
function findEpicenterProjects(cwd: string): ProjectDir[] {
  // Step 1: walk UP looking for epicenter.config.ts.
  let current = cwd;
  while (current !== dirname(current)) {
    if (existsSync(join(current, 'epicenter.config.ts'))) {
      return [current];   // single workspace project
    }
    current = dirname(current);
  }

  // Step 2: not found above. Scan immediate children of cwd.
  const children = readdirSync(cwd, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .filter(d => !d.name.startsWith('.') && d.name !== 'node_modules')
    .filter(d => existsSync(join(cwd, d.name, 'epicenter.config.ts')))
    .map(d => join(cwd, d.name) as ProjectDir);

  if (children.length > 0) {
    return children;   // monorepo with N workspaces
  }

  throw new Error('Not an Epicenter project.');
}
```

Properties:

- **Up takes priority.** If you're inside a project, that project wins, even if you're in a subdir that happens to look like a sibling.
- **Down is one level only.** Scans `cwd/*/epicenter.config.ts`. Does not recurse. Avoids `node_modules/.../epicenter.config.ts` surprises.
- **Hidden directories and `node_modules` are skipped.** Standard ignored directories.

### 9.1 Examples

```
Layout:                                Run from:                  Resolves to:
my-project/                            my-project/                my-project (single)
├── epicenter.config.ts                my-project/src/            my-project (walks up)
└── src/

my-monorepo/                           my-monorepo/               [notes, tasks] (two)
├── notes/epicenter.config.ts          my-monorepo/notes/         my-monorepo/notes (walks up)
└── tasks/epicenter.config.ts          my-monorepo/tasks/         my-monorepo/tasks (walks up)
                                       my-monorepo/notes/src/     my-monorepo/notes (walks up)

random/folder/                         random/folder/             error (no project found)
```

### 9.2 Monorepo daemon orchestration

When `findEpicenterProjects(cwd)` returns multiple projects (monorepo case), the daemon-up command starts one daemon per project. Each daemon is independent: own socket, own metadata, own lease. No cross-project coordination.

A future spec can define an "orchestrator" mode (one process serves all projects in a monorepo via routed RPC), but the canonical layout treats them as independent daemons.

## 10. `epicenter init` scaffolding

### 10.1 Invocation

```
$ epicenter init
```

### 10.2 Behavior

Reads cwd. If `epicenter.config.ts` already exists, prints "already initialized" and exits.

Otherwise:

1. Writes `epicenter.config.ts` with a minimal default-export `defineWorkspace({...})` call.
2. Writes or appends `.gitignore` with `.epicenter/` rule (idempotent).
3. Does NOT create `.epicenter/` (lazy on first daemon run).
4. Does NOT create any table directories (lazy on first materializer write).
5. Does NOT write `package.json` or `tsconfig.json` (those are `bun init`'s job).
6. Prints next steps:

```
✓ Created epicenter.config.ts
✓ Updated .gitignore

Next steps:
  1. bun add @epicenter/workspace
  2. Edit epicenter.config.ts to define your workspace schema.
  3. Run `epicenter daemon up` to start.
```

### 10.3 The default `epicenter.config.ts`

```ts
import { defineWorkspace } from '@epicenter/workspace';
import * as Y from 'yjs';

export default defineWorkspace({
  guid: 'epicenter.default',
  async open({ projectDir, openWebSocket, installationId }) {
    const ydoc = new Y.Doc({ guid: 'epicenter.default' });
    // TODO: define your schema, attach materializers, return infrastructure.
    throw new Error('epicenter.config.ts: not yet configured.');
  },
});
```

Throws on first daemon run with a clear message. The developer replaces the throw with their schema and materializer attachments. Minimum-viable scaffolding without pretending to be runnable.

## 11. Migration

### 11.1 What needs to move

```
Today's layout                          New layout
--------------                          ----------
<proj>/.epicenter/yjs/<id>.db           <proj>/.epicenter/yjs.db
<proj>/.epicenter/sqlite/<id>.db        <proj>/.epicenter/sqlite.db
<proj>/.epicenter/md/<id>/              <proj>/<tableName>/*.md (writeback target)
<proj>/.epicenter/log/                  ~/.epicenter/logs/<projectHash>/
<proj>/.epicenter/persistence/<id>.db   <proj>/.epicenter/yjs.db (rename)
workspaces -> apps symlink at root      (deleted)

API changes
-----------
defineConfig({ daemon: { routes: { ... } } })  → defineWorkspace({...}) (one workspace)
yjsPath(projectDir, workspaceId)               → yjsPath(projectDir)
sqlitePath(projectDir, workspaceId)            → sqlitePath(projectDir)
markdownPath(projectDir, workspaceId)          → tableMarkdownDir(projectDir, tableName)
```

### 11.2 Migration command

`epicenter migrate` (one-shot, idempotent). Steps:

1. Detect: read `<proj>/.epicenter/{yjs,sqlite,persistence}/*.db` if present.
2. For each existing yjs file (in `.epicenter/yjs/` or `.epicenter/persistence/`):
   - There must be exactly one workspace's data. If multiple, prompt the developer to pick which is "the" workspace (the rest become orphans to delete manually).
   - Move `.epicenter/yjs/<id>.db` to `.epicenter/yjs.db`. Similarly for sqlite.
3. Materialize markdown from the migrated yjs.db into `<proj>/<tableName>/` for each table. The new markdown becomes the committed source of truth.
4. Move daemon logs to `~/.epicenter/logs/<projectHash>/`.
5. Delete now-empty `.epicenter/yjs/`, `.epicenter/sqlite/`, `.epicenter/md/`, `.epicenter/persistence/`, `.epicenter/log/`.
6. Delete `workspaces -> apps` symlink if present.
7. Update `epicenter.config.ts`: convert `defineConfig({ daemon: { routes: { fuji } } })` to `export default fuji` (re-exporting the single workspace definition that was registered).
8. Write `.gitignore` with `.epicenter/` rule if absent.
9. Write `~/.epicenter/version.json` with `schemaVersion: 1`.
10. Report what moved.

### 11.3 Multi-workspace projects (the monorepo migration)

If today's `epicenter.config.ts` registers multiple routes, the developer chooses between:

- **Stay multi-route**: keep the old shape with a compatibility flag (deprecated; removed in next major).
- **Promote to monorepo**: each route becomes a subdirectory with its own `epicenter.config.ts`, and the old root config becomes either empty or a workspace orchestrator.

The migrate command surfaces this as a prompt with the two options.

### 11.4 Backwards compatibility window

One release with warnings; next release removes legacy support. Daemons on the old layout print:

```
Legacy layout detected (workspaces/<r>/yjs.db). Run `epicenter migrate` to upgrade.
Continuing with legacy layout for this run.
```

## 12. The canonical example: `examples/fuji/`

### 12.1 Location

`examples/fuji/`. Demonstrates the layout using fuji's existing workspace definition.

### 12.2 Tree

```
examples/fuji/
├── package.json                       ← bun + @epicenter/workspace, @epicenter/fuji
├── tsconfig.json                      ← extends repo base
├── README.md                          ← walkthrough
├── epicenter.config.ts                ← imports openFujiWorkspace, attaches materializers
├── .gitignore                         ← just `.epicenter/`
└── entries/                           ← seed markdown files; committed
    ├── welcome.md
    └── hello-fuji.md
```

`.epicenter/` is absent in the committed tree. It appears on first daemon run and stays gitignored thereafter.

### 12.3 The `epicenter.config.ts`

```ts
import { defineWorkspace } from '@epicenter/workspace';
import { openFujiWorkspace } from '@epicenter/fuji';
import {
  attachDaemonInfrastructure,
  openWriterSqlite,
  sqlitePath,
} from '@epicenter/workspace/node';
import { attachSqliteMaterializer } from '@epicenter/workspace/document/materializer/sqlite';
import {
  attachMarkdownMaterializer,
  slugFilename,
} from '@epicenter/workspace/document/materializer/markdown';
import { createLogger } from 'wellcrafted/logger';

export default defineWorkspace({
  guid: 'epicenter.fuji',
  async open({ projectDir, clientId, installationId, attachEncryption, openWebSocket }) {
    const workspace = openFujiWorkspace(attachEncryption, { clientId });

    const infra = attachDaemonInfrastructure(workspace.ydoc, {
      projectDir,
      openWebSocket,
      installationId,
      actions: workspace.actions,
    });

    const db = openWriterSqlite({
      filePath: sqlitePath(projectDir),
      log: createLogger('sqlite'),
    });
    workspace.ydoc.once('destroy', () => db.close());

    attachSqliteMaterializer(workspace.ydoc, { db }).table(workspace.tables.entries);

    // `dir: projectDir` + auto-appended table name → <projectDir>/entries/<slug>.md
    attachMarkdownMaterializer(workspace.ydoc, {
      dir: projectDir,
    }).table(workspace.tables.entries, { filename: slugFilename('title') });

    return infra;
  },
});
```

### 12.4 The seed markdown

```markdown
<!-- examples/fuji/entries/welcome.md -->
---
id: 01HM0000000000000000000000
---
# Welcome to Fuji

This is a sample entry in a Fuji workspace. Edit this file directly, or use
the daemon to drive changes. Either way, both representations stay in sync.
```

```markdown
<!-- examples/fuji/entries/hello-fuji.md -->
---
id: 01HM0000000000000000000001
---
# Hello Fuji

A second entry to show that the markdown materializer writes one file per row.
The `id` in the front-matter is the workspace's stable identifier; the
filename is derived from the title for human friendliness.
```

### 12.5 The README walkthrough

```markdown
# examples/fuji

A canonical Epicenter project. One workspace, one `epicenter.config.ts`,
table data as markdown at the project root.

## Run it

    bun install
    epicenter daemon up

## Layout

    epicenter.config.ts   ← the marker; composes the workspace
    entries/              ← table data (committed; this is the source of truth)
    .epicenter/           ← runtime cache (gitignored; regenerable)
        yjs.db
        sqlite.db

## Edit a note

Edit `entries/welcome.md` in any editor. The daemon picks up the change
and applies it to the Y.Doc; the SQLite materializer reflects it; peers
on the sync receive the update.

You can also drive edits via the daemon's actions (queries and mutations
defined in `epicenter.config.ts`).
```

### 12.6 CI assertions

```
Assertions (run after `epicenter daemon up` in CI):
  - .epicenter/yjs.db exists and is non-empty
  - .epicenter/sqlite.db exists
  - entries/welcome.md exists (was committed)
  - entries/hello-fuji.md exists (was committed)
  - .epicenter/ is gitignored (no tracked files inside)
  - .gitignore contains the `.epicenter/` rule
```

If the spec changes, the example and its assertions change with it.

## 13. Edge cases

### 13.1 Yjs.db absent on first run

`epicenter daemon up` finds no `.epicenter/yjs.db`. It reads markdown from configured table directories, hydrates the Y.Doc, then writes the initial yjs.db. Subsequent runs use the existing yjs.db; the hydration step is skipped unless markdown is detected as newer.

(This depends on the markdown → Y.Doc hydration work described in §7.2.)

### 13.2 Yjs.db present but markdown missing

User clones a repo with `.epicenter/` accidentally committed. Markdown directories are missing. Daemon materializes from yjs.db on first run, writing the markdown files. Source of truth is whatever the developer commits next.

### 13.3 Conflicting markdown front-matter

Two peers edit the same row's front-matter (e.g., both change `status`). Git's line-based merge produces a conflict marker. User resolves manually, commits. The daemon then applies the resolved version to the Y.Doc.

For body conflicts: git resolves at line level. Yjs's character-level CRDT properties are not preserved through this path. Trade-off: cleaner git workflow at the cost of finer-grained merge resolution.

### 13.4 Sync server and git both in use

Real-time collaboration via sync server. Async collaboration via git. The two are not synchronized: a peer's local Y.Doc may diverge from `entries/*.md` between materializer flushes. The reverse-watcher applies external markdown changes when detected. Possible state: server-canonical Y.Doc, locally-modified markdown, both eventually consistent via the daemon.

This is the "git as async sync" model. It works because markdown is the persistence shared by both layers.

### 13.5 Table renames

Renaming a table means renaming its markdown directory: `mv entries/ notes/`. Update the `dir:` argument in `epicenter.config.ts`. The daemon's markdown materializer now writes to `notes/`. Y.Doc table key changes accordingly. Migration of existing rows is the developer's responsibility (it's a schema change, not a layout question).

### 13.6 Multiple daemons writing the same project

The lease sqlite at `$XDG_RUNTIME_DIR/epicenter/<projectHash>.lease.sqlite` ensures only one daemon writes a given project's yjs.db at a time. Second daemon refuses to start. Behavior unchanged from current implementation.

## 14. Out of scope

- The `defineTable`, `attachTables`, `defineMutation`, `defineQuery` APIs internally.
- OS keychain integration. The auth file path is fixed in §3.3; the keychain abstraction is its own spec.
- Markdown → Y.Doc hydration. Assumed as the architectural target in §7.2; the actual implementation is separate work.
- Tauri capabilities cleanup (`apps/whispering/src-tauri/capabilities/default.json` has `"path": "**"` and shell `"validator": ".*"`; both are independent security work).
- The `epicenter compact` command for large yjs.db files.
- Sync protocol versioning over the wire.

## 15. Open questions (closed where possible)

### 15.1 Should `epicenter.config.ts` ever do more than define one workspace?

No, for now. The file's purpose is to define exactly one workspace's schema, daemon, and materializer composition. Cross-project settings (auth target, sync server URL) live in `~/.epicenter/settings.json` or env vars. If a need for project-level non-workspace config emerges, revisit.

### 15.2 What if a project legitimately needs multiple workspaces in one daemon process?

Not supported in the canonical layout. The answer is a monorepo with one project per workspace, each with its own daemon. If a process-sharing orchestrator becomes necessary, it's a new tool (an "epicenter orchestrator" config file at the monorepo root), not a complication of the basic project layout.

### 15.3 Should table directories be visible or hidden?

Visible. Markdown is human-editable content. Hiding it under `.epicenter/md/` (the old layout) understated its role. Promoting it to project root and committing it makes the data and the code coexist at the same level.

### 15.4 Should the migration tool auto-pick the "main" workspace in multi-route projects?

No. Prompt the developer; let them choose. Auto-picking risks data loss if the heuristic gets it wrong.

### 15.5 Does the spec affect existing apps (whispering, fuji, opensidian, etc.)?

Yes for their `apps/*/daemon.ts` shape and for how the root `epicenter.config.ts` registers them. The migration covers this. Existing first-party apps move to the new shape one at a time.

## 16. Summary, in one tree

```
<project>/                                  Epicenter project
├── package.json                            your file (bun init writes this)
├── tsconfig.json                           your file
├── README.md                               your file
├── epicenter.config.ts                     REQUIRED. Marker + workspace definition.
│                                           Default-exports defineWorkspace({...}).
├── .gitignore                              Epicenter-managed: `.epicenter/`
├── <tableName>/                            convention: one dir per table at root,
│   └── *.md                                visible, COMMITTED. Materializer writes here.
└── .epicenter/                             runtime cache, GITIGNORED.
    ├── yjs.db                              Yjs persistence (regenerable from markdown).
    ├── yjs.db-wal, .db-shm                 WAL sidecars.
    ├── sqlite.db                           SQL materializer (regenerable).
    ├── sqlite.db-wal, .db-shm              WAL sidecars.
    └── (other materializer outputs over time)

~/.epicenter/                               user-and-machine shared state
├── version.json                            schema version stamp.
├── settings.json                           cross-app user prefs.
├── auth/<host>.json                        fallback when OS keychain unavailable.
├── identity/local-identity.json            device key material.
├── logs/<projectHash>/daemon.log           daemon logs (per project).
└── cache/                                  free-form caches.

$XDG_RUNTIME_DIR/epicenter/                 volatile (unchanged from today)
├── <projectHash>.sock                      daemon IPC.
├── <projectHash>.meta.json                 daemon metadata.
└── <projectHash>.lease.sqlite              single-writer lease.
```

Two reservations in the project (one file, one hidden dir). One reservation in user home. One canonical convention (table dirs at project root) that's developer-configurable.

## 17. Implementation order (suggested)

1. **Path resolver swap.** Create `packages/constants/src/platform-paths.ts`. Replace `epicenterEnv` usage with `platformPaths`. Drop env-paths dependency.
2. **API rename.** `defineConfig` → `defineWorkspace`. Update existing consumers. Keep a deprecated alias for one release.
3. **Project-side helpers.** Add `yjsPath(projectDir)`, `sqlitePath(projectDir)`, `tableMarkdownDir(projectDir, tableName)` to the workspace package.
4. **`epicenter init` and `epicenter migrate`.** Implement per §10 and §11.
5. **Examples/fuji.** Create the canonical example per §12. Wire CI assertions per §12.6.
6. **Markdown → Y.Doc hydration.** The architectural prerequisite for §7. Substantial; separate workstream.
7. **Reverse watcher.** Pick up external markdown edits and apply to Y.Doc. Also separate.
8. **CLI walk-up + scan-down-one resolution.** Implement per §9.
9. **Schema version stamp.** Add `~/.epicenter/version.json` write-on-startup and refuse-if-newer check.
10. **Drop legacy layout support.** One release after `epicenter migrate` lands.

Each item is independently shippable. Items 6 and 7 are the largest and gate the full architectural payoff; until they land, yjs.db is gitignored runtime state but not yet "regenerable from markdown."
