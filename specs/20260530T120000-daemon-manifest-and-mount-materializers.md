# Daemon Manifest + Mount Materializers

**Date**: 2026-05-30
**Status**: Superseded draft. Do not implement the daemon-published project
manifest, `{ name, workspace, materializers }` mount shape, or generic mount
materializer protocol from this spec.
**Owner**: Workspace platform
**Supersedes**: `specs/20260529T220000-project-mount-local-resource-api.md` (the
`Mount.resources` declaration approach; this replaces its core mechanism)
**Builds on**: `specs/20260528T121508-config-force-mount-array.md` (`Mount[]` settled, unchanged)
**Superseded by**: current app-owned mount code and PR #1868's Fuji body-doc
direction. The path drift diagnosis remains useful, but project/mount resource
manifests are not the accepted implementation direction.

## One Sentence

Superseded model: the daemon does not own a generic manifest-backed materializer
subsystem. Fuji's project mount stays app-owned: it opens the root workspace, wires
SQLite and markdown materializers directly, and reads entry body docs per row as a
Fuji-specific projection step.

Historical rejected model:

The daemon is the single source of truth for where local data lives: it owns the
on-disk layout, publishes a `.epicenter/manifest.json` of what it materialized, and
a mount is just a workspace plus a list of materializers, so nothing in the config
or any script ever re-derives a path by convention.

## How to read this spec

```txt
Read first:
  One Sentence
  Why the previous spec patched a symptom (Trace Upstream)
  The Manifest
  The Mount Shape

Read if changing the design:
  Design Decisions
  The materializer protocol (and the framework it must NOT become)
  Two read surfaces (sqlite vs Y.Doc replay)

Execution:
  Call sites before/after, Migration, What to delete, Risks, Open Questions
```

---

## Trace Upstream: why the previous spec patched a symptom

The previous spec (`20260529T220000`) diagnosed the bug correctly: two owners for
every resource path (a mount's `open()` override vs `openWorkspaceSqlite()`
re-deriving a convention). But its fix, a `Mount.resources` declaration that BOTH
the daemon and scripts resolve, still asked the config to know about paths and
refused overrides to prevent drift.

Going one level up: the only reason a script needs to know a path at all is to
LOCATE a file the daemon already created. The daemon is the writer. It knows every
location exactly. Asking a static config (or a convention, or a re-derivation) to
independently reproduce that knowledge is the original sin. The dual-owner bug, the
gitignore-escape bug, the closed `sqlite: true` enum: all symptoms of the same root.

```txt
Root cause:
  a second party re-derives knowledge the writer already has.

Fix the root, not the symptom:
  the writer (daemon) PUBLISHES what it did. Everyone else reads that.
```

This inverts the previous spec's central trade. That spec refused path overrides to
kill the drift. This spec keeps overrides and kills the drift anyway, because the
reader gets the path from the daemon's manifest, not from a guess. You get more
flexibility AND correctness by fixing the real cause.

---

## Grounded facts (verified, not assumed)

```txt
1. WAL is already enabled "so a readonly consumer can open the same file
   concurrently without SQLITE_BUSY" (attach-yjs-log.ts:18). The single-writer
   "lock" forces WRITES through the daemon (correct, unavoidable for a CRDT) but
   never blocked READS. Concurrent readonly readers are already safe.

2. A single compacted Y.encodeStateAsUpdateV2 snapshot fully reconstructs a Y.Doc
   AND keeps merging with peers; the full op log is not required (Yjs updates are
   commutative + idempotent; the snapshot carries the delete set). [DeepWiki, yjs/yjs]
   attachYjsLog already compacts to this, so yjs.db is a complete durable form.

3. For read-only consumers, a derived/materialized projection (the SQLite mirror)
   is the RECOMMENDED pattern over reconstructing the Y.Doc in every reader.
   Reconstruction is viable but heavier. [DeepWiki, yjs/yjs]

4. The daemon ALREADY writes a single-writer JSON sidecar (metadata.ts:
   <dirHash>.meta.json, pid/dir/startedAt). A manifest is a small extension of an
   existing daemon responsibility, not a new concept.

5. attachYjsLogReader exists ("script-side mirror of a daemon's Yjs log") but is
   UNUSED in production. The full-fidelity read path is built and waiting.
```

### One read surface: SQLite (the verified answer to "do scripts need the Y.Doc?")

Tempting to offer Y.Doc replay (`attachYjsLogReader`) as a "full-fidelity" read path.
An adversarial audit killed it. Replaying the root log gives a bare, schema-less Y.Doc:
to read a row a script must import the app schema (`createFuji`), navigate the
`YKeyValueLww` structure, hold the keyring to decrypt, and apply migrations. Worse,
entry BODIES live in child Y.Docs that the shipped daemon does NOT persist (only the
`opensidian-e2e` playground does), so the root log cannot reach them at all. Replay is
slower, needs the schema and keyring, and still misses the richest data.

```txt
Verdict: the SQLite mirror is the one practical script read surface.
  sqlite mirror   flat tabular queries + FTS5, light, no schema/keyring needed at read
  markdown        human/git committed content (a different audience, not a query surface)
  Y.Doc replay    NOT a public script API (needs schema + keyring; bodies not reachable)
```

Honest limitation today: entry bodies live in child docs the daemon does not yet
persist, so the SQLite mirror holds row METADATA, not bodies. The uniform per-doc
providers spec (`20260530T160000`) fixes that root cause: once the daemon persists +
syncs every doc by guid, a body-aware `toMarkdown` (or a body column) can include
bodies. This spec just must not imply bodies are present before that lands.

---

## Design Decisions

| Decision | Class | Choice | Rationale |
| --- | --- | --- | --- |
| Source of truth for locations | 2 coherence | Daemon-published `.epicenter/manifest.json` | The writer publishes; no party re-derives. Kills the dual-owner root cause |
| Path overrides | 2 coherence | Keep them; the manifest reflects wherever the materializer actually wrote | The manifest makes overrides drift-proof, so flexibility is free. (Reverses the previous spec's refusal) |
| `Mount.resources` declaration | 2 coherence (delete) | Removed entirely | Only existed for script discovery; the manifest replaces it. Mount goes back to opaque-but-declarative |
| Mount lifecycle | 2 coherence | The daemon owns clientID, persistence, sync, action assembly, dispose, manifest | ~70% of every `open()` was identical boilerplate. Daemon owns it once |
| Mount authoring | 3 taste | `{ name, workspace, materializers: [...] }`; refuse imperative `open(ctx)` | The ~10% asymmetric cut; collapses 5 mounts from ~40 lines to ~6. See Open Question 1 for the data-vs-array alternative |
| Sync as a materializer? | 2 coherence (refuse) | No: persistence + sync are daemon-native, not plugins | Making `sync()` a plugin forces a god-object context (auth + sockets + keyring) = the deleted `ExtensionContext` smell. Keep the materializer context tiny |
| Child-doc daemon persistence | 2 coherence | Solved by the uniform per-doc providers spec, not a special materializer | Every doc (root + child) is persisted + synced by guid via `attachWorkspaceProviders`; there is no "child" special case and no `childDocs()` materializer |
| Daemon `/query` route | Deferred | Not now | The manifest + raw read already covers reads; a query API adds IPC cost and a new surface. Open Question 3 |
| Read surface | 1 evidence | SQLite mirror only; no public Y.Doc replay | Audit-verified: replay needs the app schema + keyring and cannot reach child-doc bodies. SQLite is the one practical surface |
| Manifest publishes | 2 coherence | Consumable surfaces only (sqlite path + markdown dir) | yjs.db is daemon-private (not a read surface); publishing it would imply a replay path that does not work |
| Action merge | 1 evidence | `(workspace.actions ?? {})` + each materializer's actions | Verified uniform across all 5 mounts under the invariant that iso `workspace.actions` are daemon-safe |

---

## The Manifest

A single JSON file the daemon writes on `up`, describing what it materialized for
each mount. The one source of truth for "where the data is."

```jsonc
// <projectDir>/.epicenter/manifest.json
{
	"version": 1,
	"writtenAt": "2026-05-30T12:00:00.000Z",
	"mounts": {
		"fuji": {
			"sqlite":   { "path": ".epicenter/mounts/fuji/sqlite.db" },   // the read surface
			"markdown": { "role": "content", "dir": "entries" }           // committed; human/git
		}
	}
	// yjs.db is daemon-private and intentionally NOT published: replaying it is not a
	// practical script read path (needs the app schema + keyring; bodies are in
	// unpersisted child docs). The daemon knows its location; consumers do not need it.
}
```

```txt
Writer:     the daemon, on `epicenter up`. Sole author. Regenerated every run.
Lives:      in the project's .epicenter/ (NOT the runtime sidecar). Survives daemon
            shutdown, so offline scripts can still read it. Gitignored (daemon output).
Paths:      relative to projectDir (portable across machines / clones).
Invariant:  manifest-exists  <=>  the daemon has run  <=>  the files exist.
            You only need a path when files exist, so "resolve before first run" is
            a non-need. Losing it costs nothing.
Drift:      impossible. The daemon writes the manifest from the SAME values it used
            to write the files. One writer, one artifact, one reader.
```

The manifest is GENERATED, not authored. The user never hand-writes a path. This is
the difference from the previous spec's `resources` field: that was authored in the
config (and could drift from `open`); this is emitted by the daemon from the truth.

---

## The Mount Shape

### Ideal call site

```ts
// apps/fuji/project.ts
import { defineMount } from '@epicenter/workspace/daemon';
import { markdown, sqlite } from '@epicenter/workspace/daemon/materializers';
import { slugFilename } from '@epicenter/workspace/document/materializer/markdown';
import { createFuji } from './fuji.js';

export function fuji(opts: { git?: GitAutosaveConfig } = {}) {
	return defineMount({
		name: 'fuji',
		workspace: createFuji,                        // ({ keyring }) => Workspace
		materializers: [
			markdown({ dir: 'entries', perTable: { entries: { filename: slugFilename('title') } }, git: opts.git }),
			sqlite(),
		],
	});
}
```

```ts
// apps/zhongwen/project.ts  (no materializers: a bare synced Y.Doc)
export function zhongwen() {
	return defineMount({ name: 'zhongwen', workspace: createZhongwen });
}
```

The daemon owns everything that was boilerplate:

```txt
daemon, per mount, in order:
  1. workspace = mount.workspace({ keyring })          // the only app input #1
  2. workspace.ydoc.clientID = ctx.yDocClientId        // was per-app
  3. attach yjs log at .epicenter/mounts/<name>/yjs.db // was attachProjectSync
  4. apply each materializer (waitFor: log.whenLoaded) // the only app input #2
  5. actions = merge((workspace.actions ?? {}), ...materializer.actions)  // was per-app
  6. join cloud sync (collaboration) with merged actions          // was attachProjectSync
  7. record each materializer's manifest entry; write manifest.json
  8. compose async dispose (destroy doc -> await log + sync teardown)
```

**Action-merge invariant (verified across all 5 mounts).** The daemon merges
`(workspace.actions ?? {})` with each materializer's actions. This reproduces every
mount's current behavior exactly, because of one invariant: **the iso `create<App>`
factory exposes only daemon-safe actions; browser-only actions are added in the browser
runtime, never in the iso factory.** So fuji/honeycrisp (iso actions present) merge them;
tab-manager (iso factory returns no `actions` field, browser-only) contributes `{}`;
opensidian/zhongwen (empty iso actions, no materializers) serve `{}`. The `?? {}` also
absorbs tab-manager's raw-`createWorkspace` return (no `actions` field); normalizing it
to `actions: defineActions({})` for consistency is a nice-to-have, not required.

```txt
mount         workspace.actions   materializers      daemon serves (verified == today)
fuji          present             sqlite, markdown   workspace + sqlite + markdown
honeycrisp    present             sqlite, markdown   workspace + sqlite + markdown
tab-manager   none (-> {})        sqlite, markdown   sqlite + markdown
opensidian    {}                  none               {}
zhongwen      {}                  none               {}
```

### The materializer protocol (and what it must NOT become)

A materializer is a thin function applied to an already-built workspace. The context
is deliberately tiny: workspace, the daemon-chosen base dir, the project dir (for
content paths), and a hydration barrier. **No auth, no sockets, no keyring.** That is
what keeps this from becoming the deleted `ExtensionContext`.

```ts
export type Materializer = (ctx: MaterializerContext) => MaterializerAttachment;

export type MaterializerContext = {
	workspace: Workspace;        // { ydoc, tables, kv }
	mountDir: string;            // .epicenter/mounts/<name>/  (daemon-owned base)
	projectDir: ProjectDir;      // for content paths (markdown dir)
	waitFor: Promise<unknown>;   // hydration barrier (the yjs log's replay)
};

export type MaterializerAttachment = {
	actions?: ActionRegistry;                       // merged into the mount
	manifest: ManifestEntry;                        // { kind, ...location } published
	[Symbol.asyncDispose]?(): MaybePromise<void>;   // teardown
};
```

`markdown()` and `sqlite()` are thin curries over the EXISTING attach primitives:

```ts
export function sqlite(opts: { fts?: FtsConfig; path?: string } = {}): Materializer {
	return ({ workspace, mountDir, projectDir, waitFor }) => {
		const path = opts.path ? resolve(projectDir, opts.path) : join(mountDir, 'sqlite.db');
		const m = attachBunSqliteMaterializer(workspace, { filePath: path, fts: opts.fts, waitFor });
		return { actions: m.actions, manifest: { kind: 'sqlite', path }, [Symbol.asyncDispose]: m[Symbol.asyncDispose] };
	};
}

export function markdown(opts: { dir: string; perTable: PerTableConfig; role?: 'content' | 'projection'; git?: GitAutosaveConfig }): Materializer {
	return ({ workspace, mountDir, projectDir, waitFor }) => {
		const role = opts.role ?? 'content';
		const dir = role === 'content' ? resolve(projectDir, opts.dir) : join(mountDir, 'md');
		const m = attachMarkdownMaterializer(workspace, { dir, perTable: opts.perTable, git: opts.git, waitFor });
		return { actions: m.actions, manifest: { kind: 'markdown', role, dir: opts.dir }, [Symbol.asyncDispose]: m[Symbol.asyncDispose] };
	};
}
```

**The boundary that keeps this from being a framework** (the attach-primitive skill
deleted `defineExtension`/`ExtensionContext` for adding registration indirection):

```txt
ALLOWED                                   THE MOMENT YOU WANT THIS, STOP
  independent materializers                 one materializer reading another's output
  one shared waitFor barrier                 per-materializer ordering / dependency graph
  tiny context (workspace + paths)           a context object materializers hook into
  daemon .map()s the array                   a registration/lifecycle pipeline
  returns {actions, manifest, dispose}       returns "init" / "teardown" / "upgrade" phases
```

If the left column ever needs the right column, the materializer array was the wrong
abstraction and we revert to per-mount native handling. Designed at this floor or not
at all.

### The materializer catalog

```ts
markdown({ dir, perTable, role?, git? })   // Y.Doc <-> .md; role drives home (content vs projection)
sqlite({ fts?, path? })                    // queryable mirror; daemon owns path unless overridden
// future, on a real trigger:
turso({ ... })                             // remote SQLite mirror (attachTursoMaterializer exists in plan)
```

### What was considered and rejected

| Candidate | Why rejected |
| --- | --- |
| Keep imperative `open(ctx)` | ~70% boilerplate repeated in every mount; the daemon should own the lifecycle once |
| `sync()` as a materializer | Forces a god-object context (auth/sockets/keyring) = the deleted `ExtensionContext`. Persistence + sync are daemon-native |
| Closed `{ markdown: {...}, sqlite: {...} }` data fields | The same closed-enum friction as `resources: { sqlite: true }`; a new materializer means a new field + daemon branch. (But it is simpler; see Open Question 1) |
| `Mount.resources` declaration | The manifest replaces its only job (script discovery); it could drift from `open` |
| A `childDocs()` materializer | Child docs are not a materializer concern; they are just docs. The uniform per-doc providers spec persists every doc by guid, root and child alike |
| A general `plugins: [...]` name | Today every entry materializes data. "materializers" is honest; generalize the name when a non-materializing capability earns its place |

---

## Ownership

| Concern | Owner |
| --- | --- |
| Project boundary | `epicenter.config.ts` marker; `findProjectRoot()` |
| Which mounts the daemon serves | config default export (`Mount[]`) |
| Mount identity (name) | `Mount.name` |
| Which materializers a mount runs | `Mount.materializers` (the app factory) |
| Workspace construction | `Mount.workspace` (the iso `create<App>` factory) |
| clientID, persistence, sync, action merge, dispose | the daemon (owned once, not per app) |
| Absolute path of every resource | the daemon, at materialize time |
| WHERE the data is (published) | `.epicenter/manifest.json` (daemon-written) |
| Content path (committed markdown dir) | the `markdown({ dir })` option, project-relative |
| Reading projections (scripts) | `loadProjectData(projectDir).mount(name).openSqlite()` |
| Live action calls (scripts) | `connectDaemonActions({ mount, projectDir })` |
| Daemon runtime files (socket/lease/log) | `daemon/paths.ts` under env-paths (unchanged) |

---

## Path policy

`.epicenter/` is daemon-owned and gitignored (including `manifest.json`). The
mount-major layout (`.epicenter/mounts/<name>/yjs.db|sqlite.db|md/`) is the daemon's
default, but **overrides are allowed** (a materializer option), because the manifest
publishes wherever the daemon actually wrote, so no reader can drift.

```txt
Under .epicenter/  (daemon-owned, gitignored, regenerable-or-resyncable)
  manifest.json              the published "where" (regenerated each up)
  mounts/<name>/yjs.db       CRDT log (full-fidelity source)
  mounts/<name>/sqlite.db    flat mirror (projection)
  mounts/<name>/md/          markdown PROJECTION only (role:'projection')

In the project tree  (user-owned, committed)
  epicenter.config.ts
  <markdown content dir>/    role:'content' markdown (Fuji: entries/)

Outside the project  (daemon runtime, env-paths; unchanged)
  socket, lease, metadata sidecar, log
```

A resource's home is its owner: daemon-owned -> `.epicenter/`; user-owned content ->
project tree. Override a projection path if you must; the manifest still finds it.

---

## Markdown policy

Unchanged in spirit from the previous spec: the materializer is bidirectional
(continuous Y.Doc -> md write; on-demand `markdown_push` import), and a `role`
decides ownership and home. The difference: `role` is now a `markdown()` option, not
a separate `resources` field, and the daemon publishes the resolved dir to the
manifest.

| Mode | Declaration | Base dir | Git |
| --- | --- | --- | --- |
| Content | `markdown({ role: 'content', dir: 'entries' })` (default role) | `<project>/entries/` | committed |
| Projection | `markdown({ role: 'projection', ... })` | `.epicenter/mounts/<name>/md/` | gitignored |

`dir` is the materializer base; the materializer nests each table at `<dir>/<table>/`
(so Fuji's single `entries` table under base `.` lands at `entries/`). Two content
materializers must not produce overlapping `<dir>/<table>/` folders (validated at load).

---

## Script API policy

Two doors, by need. All default `projectDir` to `findProjectRoot()`.

```ts
// READS: the SQLite mirror, located via the manifest (override-aware, no convention)
const data = await loadProjectData();
const db = data.mount('fuji').openSqlite();          // bun:sqlite, read-only
const urgent = db.query('SELECT * FROM entries WHERE tag = ?').all('urgent');

// WRITES: live, through the daemon (the sole writer): unchanged
const fuji = await connectDaemonActions<FujiActions>({ mount: 'fuji' });
await fuji.entries_update({ id, tags: ['triaged'] });
```

```ts
export type ProjectData = {
	projectDir: ProjectDir;
	mount(name: string): MountData;                 // throws if absent in the manifest
};
export type MountData = {
	name: string;
	manifest: ManifestEntry;                        // raw published locations
	openSqlite(): Database;                          // throws if this mount has no sqlite surface
	markdownDir?: string;                            // resolved committed-content dir, if any
};

/** Reads .epicenter/manifest.json. No daemon required (it persists). No auth. */
export async function loadProjectData(projectDir?: ProjectDir): Promise<ProjectData>;
```

`loadProjectData` reads the manifest the daemon left on disk; it does not import the
config or run anything. One identifier (mount name) for reads and writes; the
app-specific `FUJI_ID` import disappears. There is deliberately no Y.Doc-replay read:
the audit showed it needs the app schema + keyring and cannot reach child-doc bodies,
so SQLite is the one practical read surface. (Deferred: a daemon `/query` route, Open
Question 3. Bodies reach the read surface once the uniform per-doc providers spec
persists child docs and a body-aware `toMarkdown`/column includes them.)

---

## Call sites: before and after

### Fuji

> Path note (post `fs.allow` move): fuji's mount now lives at
> `apps/fuji/src/lib/workspace/project.ts` importing `./index.js`, not the root
> `apps/fuji/project.ts` / `./fuji.js` the snippets show. Only fuji and whispering
> (the `src-tauri/` apps) nest under `src/lib/workspace/`; the other four mounts
> keep `project.ts` at the package root.

**Before** (`apps/fuji/project.ts`, ~40 lines of `open(ctx)`): workspace +
clientID + sqlite + markdown + action merge + `attachProjectSync` +
`defineWorkspace` assembly, with `resolveProjectPath ?? sqlitePath` path math.

**After** (~10 lines, declaration only):

```ts
export function fuji(opts: { git?: GitAutosaveConfig } = {}) {
	return defineMount({
		name: 'fuji',
		workspace: createFuji,
		materializers: [
			markdown({ dir: 'entries', perTable: { entries: { filename: slugFilename('title') } }, git: opts.git }),
			sqlite(),
		],
	});
}
```

**Semantic shifts to flag**:
- Default on-disk paths change to `.epicenter/mounts/fuji/{yjs,sqlite}.db`; markdown
  stays at `entries/` (base `.`, table `entries`). **Durable data move; see Risks.**
- `clientID`, action merge, persistence, sync, and assembly leave the app entirely;
  the daemon owns them. If a mount needs daemon-only actions today, that path needs
  a home (Open Question 2).

### The script

**Before** (`docs/scripting.md`): `openWorkspaceSqlite(projectDir, FUJI_ID)` ->
guesses `.epicenter/sqlite/epicenter-fuji.db`, wrong for the overridden example.

**After**: `(await loadProjectData()).mount('fuji').openSqlite()` -> the exact path
the daemon published, override or not.

---

## Implementation Plan

Build, Prove, Remove. The manifest is the safe core; the mount-shape change is the
larger refactor. They can land in that order.

### Phase 1: Manifest (the safe win)

- [ ] **1.1** Define the manifest shape + writer in `daemon/manifest.ts`; the daemon
  collects each materialized location and writes `.epicenter/manifest.json` on `up`.
- [ ] **1.2** `loadProjectData(projectDir)` + `MountData` in `client/`, reading the
  manifest; `openSqlite()` wraps `openReadonlySqlite`. Export from `node.ts`.
- [ ] **1.3** Rewrite `docs/scripting.md` + `cli/README.md` reads section around the
  manifest and the two read surfaces.

### Phase 2: Daemon owns the lifecycle

- [ ] **2.1** `defineMount` accepts `{ name, workspace, materializers? }`; the daemon
  startup (`open-project.ts` / a new mount runner) performs steps 1-8 above.
- [ ] **2.2** Materializer protocol + `markdown()` / `sqlite()` curries in
  `daemon/materializers/`. Persistence + sync become daemon-native (split
  `attachProjectSync` into a daemon-owned persistence call + sync call).

### Phase 3: Switch every mount (stop importing the old path)

- [ ] **3.1** fuji, honeycrisp, tab-manager -> `{ workspace, materializers: [...] }`.
- [ ] **3.2** opensidian, zhongwen -> `{ workspace }` (no materializers).
- [ ] **3.3** Playgrounds + examples (opensidian-e2e, tab-manager-e2e,
  notes-cross-peer, the CLI fixture). opensidian-e2e's ad hoc daemon child-doc
  persistence is deleted in favor of the uniform per-doc providers (`20260530T160000`),
  which persists every doc by guid generically.
- [ ] **3.4** `up.ts`: stop pre-creating type-major dirs; gitignore all of
  `.epicenter/`; the daemon writes the manifest.

### Phase 4: Prove

- [ ] **4.1** Typecheck the workspace package + all apps.
- [ ] **4.2** Smoke: `epicenter up` in `examples/fuji`, then a script doing
  `loadProjectData().mount('fuji').openSqlite()` and a write through `connectDaemonActions`.
- [ ] **4.3** Verify the manifest matches on-disk reality with an override set.

### Phase 5: Remove

- [ ] **5.1** Delete `openWorkspaceSqlite`, `resolveProjectPath`, the
  `workspaceId`-keyed `sqlitePath`/`markdownPath`/`yjsPath` public signatures, and
  any leftover `resources`-declaration code from the previous spec if it landed.
- [ ] **5.2** Straggler sweep: stale JSDoc in `open-sqlite-reader.ts`,
  `bun-sqlite.ts`, the `MountContext` JSDoc; grep `FUJI_ID`-style read imports.

---

## What to delete or deprecate

```txt
DELETE
  open(ctx) imperative closures in 5 app mounts  -> { workspace, materializers }
  attachProjectSync (coupled log+sync)  -> daemon-native persistence + sync
  openWorkspaceSqlite(projectDir, workspaceId)    -> loadProjectData().mount().openSqlite()
  resolveProjectPath, workspaceId-keyed path fns  -> daemon owns layout; manifest publishes it
  up.ts type-major dir creation + multi-line .gitignore  -> ensure .epicenter/, gitignore '*'

KEEP
  Mount[] contract, defineMount (new field set), loadProjectConfig
  connectDaemonActions (the write/live door)
  attachBunSqliteMaterializer, attachMarkdownMaterializer (curried by sqlite()/markdown())
  openReadonlySqlite / openSqliteReader (primitives under openSqlite())
  daemon/paths.ts (runtime files under env-paths)

NET NEW
  daemon/manifest.ts  (small)
  daemon/materializers/  (thin curries over existing attach primitives)
  client/load-project-data.ts
```

---

## Risks

### Durable-format move (gate before Phase 5)

Re-keying `yjs.db`/`sqlite.db` to `.epicenter/mounts/<name>/` moves durable files.
Synced mounts re-sync from cloud; content-markdown mounts rebuild from committed
`entries/` via `markdown_push`. Confirm whether real projects hold durable data at
old paths; offer a one-time mover in `up` (old `<guid>.db` -> new layout) and keep
it for one release. Child docs (if ever daemon-persisted) cannot be auto-attributed
to a mount; let them resync/rebuild.

### The materializer array re-growing into a framework

The single biggest design risk. Mitigated by the explicit boundary table above. If a
materializer ever needs ordering, inter-plugin reads, or a context it hooks into,
that is the signal to revert to daemon-native handling, not to grow the protocol.

### Losing the imperative escape hatch

Refusing `open(ctx)` assumes every mount is workspace + materializers + native
sync. Verified true for all 5 shipped mounts. The one thing `open(ctx)` did that the
declarative shape must replace, per-doc persistence of root + child docs, is covered
by the uniform per-doc providers spec (`attachWorkspaceProviders`), not by a reopened
imperative door. If a future mount genuinely needs imperative wiring, that is the
trigger to design a deliberate escape, not to keep `open(ctx)` alive by default.

### Manifest staleness

If the config changes but `up` is not re-run, the manifest describes the LAST run,
which is what is actually on disk, so reads stay correct. It updates on next `up`.
Honest by construction: the manifest describes what the daemon DID, not what the
config SAYS.

### The SQLite mirror holds metadata, not bodies (until the doc-providers land)

For apps whose bodies live in child docs (Fuji entries, Honeycrisp notes, Opensidian
files), the daemon today materializes only the root tables (metadata), not the bodies
(the body-aware path, `markdown.ts`, is Tauri-gated and browser-side). So a script
reading the daemon's SQLite gets row metadata, not content. This is the current
reality, not a regression this spec introduces. The fix is the uniform per-doc
providers spec (`20260530T160000`): once the daemon persists every doc by guid, a
body-aware `toMarkdown` reads child bodies the same way `markdown.ts` does. Sequence
that spec before claiming bodies in a read surface.

### Action-merge invariant is a convention, not a type

`(workspace.actions ?? {})` is safe only while iso `create<App>` factories expose just
daemon-safe actions. That holds for all 5 mounts today and matches the existing
"runtime-specific actions live in the runtime builder" rule, but it is not type-enforced:
a future iso factory that added a browser-only action would have the daemon serve it.
Same latent risk as today's `{...workspace.actions}` spreads; document the invariant where
`create<App>` factories live.

---

## Open Questions

1. **Materializer ARRAY vs closed DATA fields.** (a) `materializers: [markdown(...),
   sqlite()]` (open, extensible, matches the plugin instinct); (b) `markdown: {...},
   sqlite: {...}` (simpler, but closed-enum friction returns).
   - **Recommendation**: (a). It is open to future materializers with zero core
     change and decouples cleanly. Finalize during implementation, as agreed.

2. **Daemon-only actions** (actions not from the workspace or a materializer). Where
   do they go in the declarative shape?
   - Options: a tiny `actions(defineActions({...}))` materializer-shaped entry, or a
     `daemonActions` field on the mount.
   - **Recommendation**: defer until a real mount needs it; today none do. Lean toward
     an `actions(...)` entry in the array (stays uniform) over a new field.

3. **Daemon `/query` route** (reads run in-process on the daemon, never touching
   files).
   - **Recommendation**: defer. The manifest + raw read covers the need; revisit if
     IPC-mediated reads are wanted for consistency or remoting.

4. **Child-doc persistence** (resolved, cross-reference).
   - Resolved by `specs/20260530T160000-uniform-per-doc-providers.md`: every doc (root
     + child) is persisted + synced by guid via `attachWorkspaceProviders`. There is no
     `childDocs()` materializer; child docs are not a special case. Sequence that spec
     alongside this one so the daemon can persist a whole workspace generically.

5. **One private DB**: collapse `yjs.db` + `sqlite.db` into one SQLite file (a
   `_yjs_updates` table beside the materialized tables).
   - **Recommendation**: defer. Minor file-count win, mild corruption-isolation cost.
     Not load-bearing for this spec.

6. **Script reader naming**: `loadProjectData` vs `openProjectReader` vs
   `loadManifest`. Bikeshed; decide in implementation.

---

## Recommendation

Land the **manifest first** (Phase 1): it is the safe, high-leverage win that alone
resolves the dual-owner bug, the gitignore escape, the `resources`-enum friction, and
the "single source of truth" question, while leaving the mount opaque and overrides
flexible. It is reversible and touches little.

Then the **mount-shape refactor** (Phases 2-3) as the larger, coherent clean break,
held to the materializer-protocol floor. Keep persistence + sync daemon-native; refuse
the imperative `open(ctx)`; finalize array-vs-data (Open Q 1) against real call sites
during implementation. Sequence the uniform per-doc providers spec (`20260530T160000`)
alongside this so the daemon persists a whole workspace (root + child docs) generically;
that is what makes the clean mount shape honest.

The asymmetric win, stated plainly: the daemon publishing what it did deletes the
entire path-declaration apparatus AND ~70% of every mount, in exchange for refusing
imperative `open()` and one playground feature. The product sentence ("the daemon
owns the data and publishes where it is; a mount is a workspace plus materializers")
survives without an "or".

---

## References

- `packages/workspace/src/document/attach-yjs-log.ts` - WAL + compaction (grounded facts 1, 2)
- `packages/workspace/src/document/attach-yjs-log-reader.ts` - the Y.Doc-replay reader; stays unused under this spec (a dead-code-deletion candidate, since the audit ruled replay out as a script surface)
- `packages/workspace/src/daemon/metadata.ts` - the existing single-writer sidecar the manifest extends
- `packages/workspace/src/daemon/attach-project-sync.ts` - split into daemon-native persistence + sync
- `packages/workspace/src/daemon/define-mount.ts` / `workspace-apps/open-project.ts` - the new mount shape + daemon runner
- `packages/workspace/src/document/materializer/{sqlite,markdown}/` - curried by `sqlite()` / `markdown()`
- `apps/{fuji,honeycrisp,tab-manager,opensidian,zhongwen}/project.ts` - the 5 mounts to convert
- `playground/opensidian-e2e/.../daemon.ts` - ad hoc child-doc persistence, replaced by the uniform per-doc providers
- `packages/cli/src/commands/up.ts` - manifest write + gitignore simplification
- `specs/20260530T160000-uniform-per-doc-providers.md` - the per-doc persistence foundation this mount shape depends on
- `specs/20260529T220000-project-mount-local-resource-api.md` - superseded; retains the drift evidence + markdown-bidirectional detail
