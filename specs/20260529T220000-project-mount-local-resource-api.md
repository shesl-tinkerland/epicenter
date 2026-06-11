# Project / Mount Local Resource API

**Date**: 2026-05-29
**Status**: Superseded. Do not implement `Mount.resources`, project resource
manifests, or mount resource declarations from this spec.
**Superseded by**: current app-owned mount code and PR #1868's Fuji body-doc
direction. The drift evidence remains valid: `openWorkspaceSqlite(projectDir,
workspaceId)` only follows the convention path and is not override-aware.
**Owner**: Workspace platform
**Supersedes (resource/path layer only)**: the open path questions in
`specs/20260527T120000-project-folders-and-control-plane-vision.md` (Q3, Q4) and
the per-resource override convention introduced around commit `2705d8882`.
**Builds on**: `specs/20260528T121508-config-force-mount-array.md` (`Mount[]` is settled and unchanged here).

## One Sentence

Superseded model: local resource paths are still app mount options plus explicit
reader paths today. There is no accepted project or mount resource manifest API.

Historical rejected model:

A mount declares its local resources as inert data; one resolver turns that
declaration into absolute paths (projections under `.epicenter/mounts/<name>/`,
content inside the project tree); the daemon writes them and scripts open them
through the same declaration, so no layer re-derives a resource path by convention.

## How to read this spec

```txt
Read first:
  One Sentence
  Current State
  The Drift (the bug)
  Proposed Shape
  Ownership / Path / Markdown / Script policies

Read if changing the design:
  Design Decisions
  The MountResources catalog (+ rejected candidates)
  Call sites: before and after

Execution:
  Migration Plan (Build, Prove, Remove)
  What to delete
  Risks and Open Questions
  Recommendation
```

---

## Overview

`epicenter.config.ts` default-exports `Mount[]`. Each mount opens a Y.Doc and
(optionally) materializes a SQLite mirror and a markdown surface to disk. Today
those resource *paths* are computed in two unrelated places: inside each mount's
`open()` (as materializer side effects, overridable per project) and again inside
`openWorkspaceSqlite()` (re-derived from a fixed convention). When the two disagree,
scripts open the wrong file. This spec makes a mount's resources a declared,
introspectable part of the `Mount` value, resolved by a single function that both
the daemon and scripts call.

---

## Motivation

### Current State

A `Mount` is a name plus an opaque `open()`:

```ts
// packages/workspace/src/daemon/define-mount.ts
export type Mount<TRuntime extends DaemonRuntime = DaemonRuntime> = {
	name: string;
	open(ctx: MountContext): MaybePromise<TRuntime>;
};
```

Resource paths are computed *inside* `open()`. A materializing mount (Fuji,
Honeycrisp, Tab Manager are structurally identical) resolves an optional override,
falling back to a library convention:

```ts
// apps/fuji/project.ts:62-77
const sqliteFile =
	resolveProjectPath(projectDir, opts.sqliteFile) ??
	sqlitePath(projectDir, workspace.ydoc.guid);     // .epicenter/sqlite/<guid>.db
const mdDir =
	resolveProjectPath(projectDir, opts.markdownDir) ??
	markdownPath(projectDir, workspace.ydoc.guid);   // .epicenter/md/<guid>/

const sqlite = attachBunSqliteMaterializer(workspace, { filePath: sqliteFile, ... });
const markdown = attachMarkdownMaterializer(workspace, { dir: mdDir, perTable: { entries: ... } });
```

The canonical example overrides both paths:

```ts
// examples/fuji/epicenter.config.ts
export default [
	fuji({
		markdownDir: '.',                 // entries/*.md at the project root (committed)
		sqliteFile: '.epicenter/sqlite.db', // flat, not the convention's .epicenter/sqlite/<id>.db
	}),
];
```

A script reads the mirror by re-deriving the convention, by `workspaceId`, with no
knowledge of the override:

```ts
// packages/workspace/src/document/open-workspace-sqlite.ts:40-45
export function openWorkspaceSqlite(projectDir: ProjectDir, workspaceId: string): Database {
	return openReadonlySqlite(sqlitePath(projectDir, workspaceId)); // .epicenter/sqlite/<workspaceId>.db
}
```

### The Drift (the bug)

There are **two owners for every resource path**: the mount's `open()` (which can
override) and the convention helpers `sqlitePath()/markdownPath()` (which the reader
re-derives). When they diverge, three things break, all already live in the repo:

```txt
1. The canonical script is broken against the canonical example.
   docs/scripting.md:20   openWorkspaceSqlite(projectDir, FUJI_ID)
                          -> opens .epicenter/sqlite/epicenter-fuji.db
   examples/fuji          fuji({ sqliteFile: '.epicenter/sqlite.db' })
                          -> daemon wrote .epicenter/sqlite.db
   Result: the documented read throws "no such file".

2. The override escapes the generated .gitignore.
   up.ts:257   .epicenter/.gitignore = ['sqlite/','yjs/','md/','log/']
   Fuji wrote  .epicenter/sqlite.db  (a flat file, not under sqlite/)
   Result: the SQLite mirror is committed to git by accident.

3. The example's own layout comment is fiction.
   examples/fuji header claims  .epicenter/yjs.db
   attach-project-sync.ts:68 writes  .epicenter/yjs/<guid>.db
   Result: the documented layout never existed; yjs has no override knob,
           sqlite/markdown do. The override model is already inconsistent.
```

This creates concrete problems:

1. **No single owner for a resource path.** The materializer write path and the
   reader path are computed independently. Correctness depends on them agreeing,
   and they already do not.
2. **Resources are not introspectable.** A script cannot ask a mount "where is your
   SQLite?" It must import an app-specific `workspaceId` constant and guess the
   convention. Two identifiers (writes addressed by `mount` name, reads by
   `workspaceId`) with no runtime bridge.
3. **The path model assumed one workspace; the mount model is now always plural.**
   `Mount[]` is settled, but the flat `.epicenter/sqlite.db` layout has no answer
   for N mounts (collision). This is Spec 3's open Q3, never resolved.
4. **Markdown's status is undefined.** The path helper docs call markdown a one-way
   "projection," but the materializer is bidirectional (`markdown_push` imports
   `.md` back into the Y.Doc). The example treats markdown as committed content at
   the project root. Nothing declares which it is.

### Desired State

A mount declares its resources next to `open()` as inert data; one resolver maps
the declaration to absolute paths; the daemon and scripts both read through it.

```ts
// apps/fuji/project.ts (target)
export function fuji(opts: FujiMountOptions = {}) {
	return defineMount({
		name: 'fuji',
		resources: {
			sqlite: true,                            // daemon owns the path
			markdown: { role: 'content', path: '.' }, // base dir; the `entries` table nests as entries/
		},
		open(ctx) {
			/* wires materializers to ctx.resources.*.path; no path math here */
		},
	});
}
```

```ts
// a script: one identifier (mount name), the real path, no daemon, no auth
const project = await loadProjectResources();
const db = project.mount('fuji').openSqlite();
```

---

## Research Findings

### Spec history converges on the boundary, leaves the path model open

Four specs trace the project/mount boundary to a settled point and leave the
resource/path layer unresolved:

| Spec | Locked in | Left open |
| --- | --- | --- |
| `20260519` project-as-first-class | file marker (`epicenter.config.ts`), config-is-registry, `~/` is not a project | `.epicenter/` sub-layout |
| `20260522` workspace-project-layout | `.epicenter/` is gitignored runtime state; markdown-as-canonical (gated on unbuilt reverse-watcher) | flat vs nested keying |
| `20260527` control-plane-vision | one folder = one daemon = usually one mount; multi is an escape hatch | **Q3 flat vs `<id>` nested; Q4 markdown cache vs visible content** |
| `20260528` config-force-mount-array | `Mount[]` always; vocabulary settled on `Mount`/`defineMount`; daemon spine speaks `Mount[]` end to end | resource/path model untouched |

**Key finding**: the *project boundary* and *mount declaration* are closed. The
*resource/path model below the project root* is the unfinished work. The sharpest
gap is that the path scheme assumed a single workspace while `Mount[]` is now
always plural.

**Implication**: this spec only needs to design the resource/path layer. It must
not reopen the `Mount[]` contract.

### The markdown materializer is bidirectional, but manual

The path-helper JSDoc says markdown is a one-way projection
(`workspace-paths.ts:10`: "sqlite and md are projections the materializers keep in
sync"). The materializer code disagrees:

```txt
materializer.ts  Y.Doc -> md   continuous write-observer (table row -> .md file)
materializer.ts  md -> Y.Doc   markdown_push action (import .md as rows, additive)
                               PushEvent: imported | skipped | error; fromMarkdown callback
```

`markdown_push` is an on-demand mutation, not an automatic filesystem watcher. So
"bidirectional" today means: continuous write out, on-demand import back. An
automatic reverse-watcher (external edits flow live into the Y.Doc) is still the
unbuilt work Spec 2 flagged in §7.2.

**Implication**: markdown genuinely has three possible relationships to the Y.Doc
(generated projection, committed content with manual import, future live
bidirectional). A `role` discriminator is earned: it is a real product distinction
already half-present in the code.

### Daemon runtime files are already cleanly separated

Sockets, lease, metadata, and logs live under `env-paths` (`daemon/paths.ts`,
hash-keyed by project dir), entirely outside `.epicenter/`. So `.epicenter/` under a
project is *only* per-mount workspace data. The runtime/data split already exists
and is correct; this spec does not touch `daemon/paths.ts`.

---

## Design Decisions

| Decision | Class | Choice | Rationale |
| --- | --- | --- | --- |
| Resource paths get one owner | 2 coherence | A `resolveMountResources()` function; both daemon and script call it | Kills the dual-owner drift at the root |
| Mount declares resources | 2 coherence | Add inert `resources?: MountResources` to `Mount` | Introspectable without running `open()`; Go-to-Def from config lands on the literal |
| Projection path overrides | 3 taste (refuse) | Refuse `sqliteFile` / `markdownDir`; daemon owns `.epicenter/mounts/<name>/` | Asymmetric win: deletes `resolveProjectPath`, the `?? convention` fallbacks, the gitignore-escape bug, and the script-correctness gap. Loss is cosmetic |
| On-disk keying | 1 evidence + 3 taste | Mount-major: `.epicenter/mounts/<name>/...`, not `<workspaceId>`-major | Mount names are validated unique + alphanumeric (`mount-validation.ts`); multi-mount-safe; short and readable; resolves Spec 3 Q3 |
| Markdown ownership | 2 coherence | `role: 'projection' \| 'content'` drives the path home | Projection -> `.epicenter/` (daemon-owned, gitignored). Content -> project tree (user-owned, committed). Matches the bidirectional materializer reality |
| Content path scope | 3 taste (refuse) | Content `path` is project-relative; reject absolute and `..` at load | Keeps committed content inside the folder boundary; tightens the old `resolveProjectPath` leak that allowed absolute escapes |
| yjs log | 2 coherence | Re-key to `.epicenter/mounts/<name>/yjs.db`; resolved like the rest | It already had a fixed, un-overridable path; just align it under the per-mount subtree |
| Script identifier | 2 coherence | Address local resources by `mount` name, not `workspaceId` | Unifies with the write path (`connectDaemonActions({ mount })`); drops the app-specific `FUJI_ID` import |
| Two script modes stay distinct | 2 coherence | `connectDaemonActions` (live actions) and `loadProjectResources` (on-disk reads) are separate surfaces | Honest asymmetry: two unlike operations, two call shapes |
| Live reverse-watcher | Deferred | Not in scope | `role: 'content'` names the intent; the watcher is independent follow-up (Spec 2 §7.2) |
| Old on-disk data | 1 evidence | Verify whether durable data exists at old paths before deleting the old layout | yjs.db is durable; see Risks |

---

## The `MountResources` catalog

The factory author declares which resources a mount materializes. Inert data: no
side effects, no `open()` call required to read it.

```ts
// packages/workspace/src/daemon/define-mount.ts

/** The local resources a mount materializes, declared on the Mount value. */
export type MountResources = {
	/** Presence = "this mount keeps a queryable SQLite mirror." Daemon owns the path. */
	sqlite?: true;
	/** A markdown surface. The role decides ownership and on-disk home. */
	markdown?: MarkdownResource;
};

export type MarkdownResource =
	/** Daemon-owned, write-only. .epicenter/mounts/<name>/md/, gitignored, regenerable. */
	| { role: 'projection' }
	/**
	 * User-owned committed content. `path` is RELATIVE to the project root
	 * (absolute and `..` rejected at config load). Daemon writes Y.Doc -> md
	 * continuously; edits flow back via the `markdown_push` action. The durable,
	 * human-readable copy of the data.
	 */
	| { role: 'content'; path: string };

export type Mount<TRuntime extends DaemonRuntime = DaemonRuntime> = {
	name: string;
	resources?: MountResources;
	open(ctx: MountContext): MaybePromise<TRuntime>;
};
```

The resolved shape (absolute paths) and the one resolver:

```ts
// packages/workspace/src/daemon/mount-resources.ts

export type ResolvedMountResources = {
	/** Mount data root: `.epicenter/mounts/<name>/`. */
	dir: string;
	/** Root Y.Doc CRDT log. Always present; daemon-owned source of truth. */
	yjs: { path: string };
	/** Queryable SQLite mirror. Present iff the mount declared `sqlite`. */
	sqlite?: { path: string };
	/**
	 * Markdown surface. Present iff the mount declared `markdown`. `path` is the
	 * materializer BASE dir; the materializer nests each table at `<path>/<table>/`
	 * (see Markdown policy).
	 */
	markdown?: { role: 'projection' | 'content'; path: string };
	/**
	 * Path for a dynamic child / fan-out doc (`createDisposableCache`), keyed by
	 * its runtime guid: `.epicenter/mounts/<name>/docs/<guid>.db`. Guid-keying is
	 * load-bearing here (child docs are created per row at runtime and cannot be
	 * statically declared), so this is the ONE place guid keying survives.
	 */
	childDoc(guid: string): { path: string };
};

/**
 * The ONE place a resource path is computed. The daemon (via MountContext) and
 * scripts (via loadProjectResources) both call this, so a mount's mirror is
 * found at exactly the path the daemon wrote.
 *
 * Assumes `mount.name` passed `validateMountNames`
 * (`/^[A-Za-z0-9][A-Za-z0-9_-]*$/`: no dots or path separators), so it is safe
 * as a single path segment. Content paths are validated at config load.
 */
export function resolveMountResources(
	projectDir: ProjectDir,
	mount: Mount,
): ResolvedMountResources {
	const dir = join(projectDir, '.epicenter', 'mounts', mount.name);
	const declared = mount.resources ?? {};
	const resolved: ResolvedMountResources = {
		dir,
		yjs: { path: join(dir, 'yjs.db') },
		childDoc: (guid) => ({ path: join(dir, 'docs', `${guid}.db`) }),
	};
	if (declared.sqlite) resolved.sqlite = { path: join(dir, 'sqlite.db') };
	if (declared.markdown) {
		// content `path` is the markdown BASE dir, resolved against the project
		// root; the materializer nests each table under it (`<base>/<table>/`).
		resolved.markdown =
			declared.markdown.role === 'projection'
				? { role: 'projection', path: join(dir, 'md') }
				: { role: 'content', path: join(projectDir, declared.markdown.path) };
	}
	return resolved;
}
```

### What was considered and rejected

| Candidate | Why rejected |
| --- | --- |
| Keep `sqliteFile` / `markdownDir` overrides | They are exactly the second owner that caused the drift. Refusing them deletes `resolveProjectPath`, three `?? convention` fallbacks, and the gitignore-escape bug |
| `sqlite?: SqliteResource` (object marker) | No real per-mount SQLite option exists today. `sqlite?: true` is honest; widen to an object when a concrete option appears (greenfield earned-trigger test) |
| Key the mount's ROOT doc by `workspaceId` (`<id>.db`) | Global key for the one statically-known local file. Mount name is unique within a project, shorter, multi-mount-safe. Removes the mount->workspaceId bridge a script needed. (Dynamic CHILD docs still key by guid; see below) |
| Absolute content paths (old `resolveProjectPath` allowed `/tmp/notes`) | Content lives in the project so git tracks it. Absolute paths break "a project is a folder boundary" |
| `markdown` as a single optional dir (no role) | Cannot express the projection-vs-content ownership difference, which decides gitignore membership and durability |
| Per-resource `resources(projectDir)` resolver method on Mount | A method is less introspectable than a literal; Go-to-Def lands on a function body, not the declaration |
| Declaring `yjs` in `MountResources` | Every mount has exactly one ROOT Y.Doc log at a fixed daemon-owned path. Declaring it is ceremony; it is implicit and always resolved |

### Child / fan-out documents (the guid-keyed exception)

A mount's ROOT doc is one statically-known Y.Doc, so its path keys by mount name.
But a mount can also fan out into **dynamic per-row child docs** via
`createDisposableCache` (Fuji's `entryContentDocs`, Opensidian's per-file content
docs). A daemon that persists those (the `opensidian-e2e` playground does today)
writes one Y.Doc log per child, keyed by the child's runtime guid:

```ts
// playground/opensidian-e2e/.../daemon.ts:56-64 (today)
const fileContentDocs = createDisposableCache((fileId) => {
	const contentYdoc = new Y.Doc({ guid: opensidianFileContentDocGuid(fileId) });
	const contentPersistence = attachYjsLog(contentYdoc, {
		filePath: yjsPath(projectDir, contentYdoc.guid),   // guid-keyed, dynamic
	});
	...
});
```

Child docs are created at runtime per row; their set is unknown at config-load, so
they **cannot** be statically declared and guid-keying is load-bearing. The model
keeps the two cases distinct:

```txt
ROOT doc    statically known    keyed by mount name    ctx.resources.yjs.path
                                                       -> .epicenter/mounts/<name>/yjs.db
CHILD docs  dynamic, per row     keyed by child guid    ctx.resources.childDoc(guid).path
                                                       -> .epicenter/mounts/<name>/docs/<guid>.db
```

So `resolveMountResources` exposes `childDoc(guid)`: guid keying survives there and
nowhere else. The blanket "refuse guid keying" applies only to the root doc; the
resolver, not each consumer, still owns the child-doc layout (one owner, scoped
under the mount's subtree). This is why the migration deletes the guid-keyed
`yjsPath` *signature* but not its capability: it moves into `childDoc`.

---

## Architecture

### One declaration, one resolver, two consumers

```txt
epicenter.config.ts
  export default [ fuji() ]
        |
        v  (Mount.resources: inert data; reading it never runs open())
   resolveMountResources(projectDir, mount)        <-- the single owner of paths
        |
        +-----------------------------+------------------------------+
        v                             v                              v
   DAEMON                         SCRIPT (reads)                 SCRIPT (writes)
   open(ctx) wires materializers  loadProjectResources()         connectDaemonActions()
   to ctx.resources.*.path        .mount('fuji').openSqlite()    .mount = 'fuji'  (unchanged)
        |                             |                              |
        v                             v                              v
   writes the files              opens the same files           live actions over socket
```

### On-disk layout (mount-major)

```txt
my-project/
  epicenter.config.ts            project marker + Mount[]            (committed)
  entries/                       Fuji content markdown (role:content) (committed)
    welcome.md
  .epicenter/                    daemon-owned; gitignored wholesale
    .gitignore                   "*"  (one line; content lives outside .epicenter/)
    mounts/
      fuji/
        yjs.db                   root CRDT log: source of truth for collaboration
        sqlite.db (+ -wal/-shm)  queryable projection (regenerable)
      tab-manager/
        yjs.db
        sqlite.db
        md/                      markdown PROJECTION (role:projection), regenerable
      opensidian/                a fan-out mount
        yjs.db                   root doc
        docs/                    per-row child docs, guid-keyed (createDisposableCache)
          <child-guid>.db
```

Daemon runtime files (socket, lease, metadata, log) stay under `env-paths`,
outside the project, unchanged.

---

## Ownership

Every value and invariant has exactly one owner.

| Concern | Owner |
| --- | --- |
| Project boundary (the folder) | `epicenter.config.ts` marker; `findProjectRoot()` walks up |
| Which mounts the daemon serves | `epicenter.config.ts` default export (`Mount[]`) |
| Mount identity (name) | `Mount.name` (the app factory hardcodes it, e.g. `'fuji'`) |
| Which local resources a mount has | `Mount.resources` (inert declaration on the factory) |
| Absolute path of each resource | `resolveMountResources()` (the single resolver) |
| Projection layout policy (`.epicenter/mounts/<name>/...`) | the resolver; not overridable |
| Content path (where committed markdown lives) | `Mount.resources.markdown.path`, project-relative |
| Writing / materializing the resources | the daemon, via `open(ctx)` wiring to `ctx.resources.*.path` |
| Y.Doc CRDT log (source of truth) | the daemon (`attachProjectSync`, writes `ctx.resources.yjs.path`) |
| Reading projections (scripts) | `loadProjectResources(projectDir).mount(name).openSqlite()` |
| Live action calls (scripts) | `connectDaemonActions({ mount, projectDir })` over the socket |
| Daemon runtime files (socket/lease/log) | `daemon/paths.ts` under `env-paths` (out of `.epicenter/`, unchanged) |

---

## Path policy

The rule, stated once: **a resource's home is its owner.** Daemon-owned state lives
under `.epicenter/` (gitignored). User-owned content lives in the project tree
(committed). The dividing line is *ownership*, not *deletability*.

```txt
Under .epicenter/  (daemon-owned, gitignored)
  mounts/<name>/yjs.db     CRDT log. Source of truth for collaboration.
                           Resyncable from cloud (synced mounts); rebuildable
                           from committed content markdown (content mounts).
  mounts/<name>/sqlite.db  Pure projection. Safe to delete; daemon rebuilds.
  mounts/<name>/md/        Markdown PROJECTION only. Safe to delete; rebuilds.
  .gitignore               "*"

In the project tree  (user-owned, committed)
  epicenter.config.ts      the project marker
  <content path>/*.md      role:'content' markdown (Fuji: entries/)

Outside the project  (daemon runtime, env-paths; unchanged)
  socket, lease, metadata, log   hash-keyed per project dir
```

This corrects the specs' loose "`.epicenter/` is regenerable cache" language: the
yjs log is daemon-owned but not always regenerable. It belongs in `.epicenter/`
because the daemon owns it, not because it is disposable. The gitignore becomes
trivially correct (`*`) because nothing user-owned lives under `.epicenter/`.

---

## Markdown policy

The materializer already moves data both ways. The `role` field names which
relationship a mount wants, and that drives the path home and git treatment.

| Mode | Declaration | Base dir | Git | Direction today |
| --- | --- | --- | --- | --- |
| Projection | `markdown: { role: 'projection' }` | `.epicenter/mounts/<name>/md/` | gitignored | Y.Doc -> md only |
| Content | `markdown: { role: 'content', path }` | `<project>/<path>/` | committed | Y.Doc -> md continuous; md -> Y.Doc via `markdown_push` |

The `path` (and the projection base) is the materializer BASE dir. The materializer
nests each table at `<base>/<table>/`. Fuji declares `path: '.'`, so its single
`entries` table lands at `<project>/entries/`. A two-table content mount with
`path: 'content'` would produce `content/notes/` and `content/tasks/`. Two content
mounts in one project must not produce overlapping `<base>/<table>/` folders
(validated at config load).

```txt
role: 'projection'   md is a disposable view of the Y.Doc. Delete it freely.
                     Use when markdown is a convenience export, not the source.

role: 'content'      md is the durable, human-readable copy. The daemon keeps it
                     written; the user edits it in their editor; `markdown_push`
                     imports edits back. This is Fuji's mode (entries/).

NOT YET (deferred)   Automatic reverse-watcher: external edits flow into the Y.Doc
                     live, no manual push. Independent follow-up (Spec 2 §7.2).
                     `role: 'content'` is forward-compatible with it.
```

Honest scope: `role: 'content'` does not promise live two-way sync today. It
promises the file lives in the committed project tree and that import is available
on demand. The reverse-watcher is named and deferred, not implied.

---

## Script API policy

Two distinct script modes, two call shapes. Both default `projectDir` to
`findProjectRoot()`.

```ts
// Mode 1: live action calls over the daemon socket (UNCHANGED)
const fuji = await connectDaemonActions<FujiActions>({ mount: 'fuji' });
await fuji.entries_update({ id, tags: ['triaged'] });

// Mode 2: read on-disk projections directly (NEW; replaces openWorkspaceSqlite)
const project = await loadProjectResources();
const db = project.mount('fuji').openSqlite();    // exact path the daemon wrote
```

The new surface:

```ts
// packages/workspace/src/client/load-project-resources.ts

export type ProjectResources = {
	projectDir: ProjectDir;
	mounts: ResolvedMount[];
	/** Look up one mount by its `Mount.name`. Throws if absent. */
	mount(name: string): ResolvedMount;
};

export type ResolvedMount = {
	name: string;
	resources: ResolvedMountResources;
	/** Open the SQLite mirror read-only. Throws if this mount declares no sqlite. */
	openSqlite(): Database;
	/** FTS5 reader over the same file. Throws if this mount declares no sqlite. */
	openSqliteReader(): SqliteReader;
};

/**
 * Resolve a project's declared mount resources from `epicenter.config.ts`. No
 * daemon, no auth: importing the config reads inert `resources` declarations
 * without running any `open()`.
 */
export async function loadProjectResources(
	projectDir: ProjectDir = findProjectRoot(),
): Promise<ProjectResources>;
```

Why this works without a daemon or auth: `fuji()` and `defineMount()` are pure;
the side effects live in `open()`, which `loadProjectResources` never calls. The
re-key from `<guid>` to `<mount name>` is what makes pure resolution possible:
today the path depends on `workspace.ydoc.guid`, which only exists after
`createFuji()` runs *inside* `open()`. Mount name lives on the inert value, so the
path is computable without constructing anything. A cron job resolves and opens a
mirror with zero startup cost, exactly as `openWorkspaceSqlite` does today, but
reading the *declared* path instead of a guessed one.

The script identifier collapses from two (`mount` for writes, `workspaceId` for
reads) to one (`mount`). The app-specific `FUJI_ID` import disappears.

---

## Call sites: before and after

### Fuji (SQLite + content markdown)

**Before** (`apps/fuji/project.ts:35-101`):

```ts
export type FujiMountOptions = {
	markdownDir?: string;
	sqliteFile?: string;
	git?: GitAutosaveConfig;
};

export function fuji(opts: FujiMountOptions = {}) {
	return defineMount({
		name: 'fuji',
		open(ctx) {
			const { projectDir, mount, yDocClientId, ownerId, deviceId, keyring,
				openWebSocket, onReconnectSignal } = ctx;
			const workspace = createFuji({ keyring });
			workspace.ydoc.clientID = yDocClientId;

			const sqliteFile =
				resolveProjectPath(projectDir, opts.sqliteFile) ??
				sqlitePath(projectDir, workspace.ydoc.guid);
			const mdDir =
				resolveProjectPath(projectDir, opts.markdownDir) ??
				markdownPath(projectDir, workspace.ydoc.guid);

			const sqlite = attachBunSqliteMaterializer(workspace, {
				filePath: sqliteFile, log: createLogger(`${mount}-sqlite`),
			});
			const markdown = attachMarkdownMaterializer(workspace, {
				dir: mdDir, perTable: { entries: { filename: slugFilename('title') } }, git: opts.git,
			});
			const actions = defineActions({ ...workspace.actions, ...sqlite.actions, ...markdown.actions });
			const infrastructure = attachProjectSync(workspace.ydoc, {
				projectDir, ownerId, deviceId, openWebSocket, onReconnectSignal, actions,
			});
			return defineWorkspace({ ...workspace, ...infrastructure, markdown, actions });
		},
	});
}
```

**After**:

```ts
export type FujiMountOptions = {
	git?: GitAutosaveConfig;   // path options gone; git is a deployment choice, kept
};

export function fuji(opts: FujiMountOptions = {}) {
	return defineMount({
		name: 'fuji',
		resources: {
			sqlite: true,
			markdown: { role: 'content', path: '.' }, // base dir = project root; `entries` table -> entries/
		},
		open(ctx) {
			const workspace = createFuji({ keyring: ctx.keyring });
			workspace.ydoc.clientID = ctx.yDocClientId;

			const sqlite = attachBunSqliteMaterializer(workspace, {
				filePath: ctx.resources.sqlite.path,
				log: createLogger(`${ctx.mount}-sqlite`),
			});
			const markdown = attachMarkdownMaterializer(workspace, {
				dir: ctx.resources.markdown.path,
				perTable: { entries: { filename: slugFilename('title') } },
				git: opts.git,
			});
			const actions = defineActions({ ...workspace.actions, ...sqlite.actions, ...markdown.actions });
			const infrastructure = attachProjectSync(workspace.ydoc, {
				yjsLogPath: ctx.resources.yjs.path,
				ownerId: ctx.ownerId, deviceId: ctx.deviceId,
				openWebSocket: ctx.openWebSocket, onReconnectSignal: ctx.onReconnectSignal, actions,
			});
			return defineWorkspace({ ...workspace, ...infrastructure, markdown, actions });
		},
	});
}
```

**Semantic shifts to flag**:
- The default on-disk paths change: `.epicenter/sqlite/epicenter-fuji.db` ->
  `.epicenter/mounts/fuji/sqlite.db`; `.epicenter/yjs/epicenter-fuji.db` ->
  `.epicenter/mounts/fuji/yjs.db`. **Durable data move; see Migration / Risks.**
- `entries/` content markdown is unchanged on disk. The content `path` is the
  markdown BASE dir (the old `markdownDir`), so `path: '.'` plus the `entries`
  table yields `<project>/entries/`, exactly as today. Declaring `path: 'entries'`
  would wrongly nest at `entries/entries/` (the materializer appends the table
  name under the base). It is now declared in `fuji()` rather than passed per project.
- `attachProjectSync` takes `yjsLogPath` instead of `projectDir`. It no
  longer knows about path conventions; it persists to the path it is handed.

### The example config collapses

**Before** (`examples/fuji/epicenter.config.ts`):

```ts
export default [
	fuji({ markdownDir: '.', sqliteFile: '.epicenter/sqlite.db' }),
];
```

**After**:

```ts
export default [fuji()];   // resources are part of fuji's identity now
```

### Zhongwen (a real non-materializing mount)

**Before** (`apps/zhongwen/project.ts:15-39`): a bare Y.Doc, no materializers, no
options. **After**: identical, with `resources` simply omitted.

```ts
export function zhongwen() {
	return defineMount({
		name: 'zhongwen',
		// no `resources`: only the implicit yjs log at .epicenter/mounts/zhongwen/yjs.db
		open(ctx) {
			const workspace = createZhongwen({ keyring: ctx.keyring });
			workspace.ydoc.clientID = ctx.yDocClientId;
			const infrastructure = attachProjectSync(workspace.ydoc, {
				yjsLogPath: ctx.resources.yjs.path,
				ownerId: ctx.ownerId, deviceId: ctx.deviceId,
				openWebSocket: ctx.openWebSocket, onReconnectSignal: ctx.onReconnectSignal,
				actions: workspace.actions,
			});
			return defineWorkspace({ ...workspace, ...infrastructure });
		},
	});
}
```

A script calling `project.mount('zhongwen').openSqlite()` throws a clear
"mount 'zhongwen' declares no sqlite resource" instead of opening a phantom path.

### A SQLite-only mount (non-markdown, for contrast)

```ts
defineMount({
	name: 'metrics',
	resources: { sqlite: true },   // mirror only, no markdown
	open(ctx) {
		/* attachBunSqliteMaterializer({ filePath: ctx.resources.sqlite.path, fts: {...} }) */
	},
});
// script: project.mount('metrics').openSqlite()  // works; markdown access would throw
```

### The script

**Before** (`docs/scripting.md:9-32`):

```ts
import { connectDaemonActions, findProjectRoot, openWorkspaceSqlite } from '@epicenter/workspace/node';
import { FUJI_ID, type FujiActions } from '@epicenter/fuji';

const projectDir = findProjectRoot();
const db = openWorkspaceSqlite(projectDir, FUJI_ID);   // WRONG path for the canonical example
const urgent = db.query('SELECT * FROM entries WHERE tag = ?').all('urgent');
const fuji = await connectDaemonActions<FujiActions>({ mount: 'fuji', projectDir });
```

**After**:

```ts
import { connectDaemonActions, loadProjectResources } from '@epicenter/workspace/node';
import type { FujiActions } from '@epicenter/fuji';

const project = await loadProjectResources();
const db = project.mount('fuji').openSqlite();         // exact path the daemon wrote
const urgent = db.query('SELECT * FROM entries WHERE tag = ?').all('urgent');
const fuji = await connectDaemonActions<FujiActions>({ mount: 'fuji' });
```

---

## Implementation Plan

Build, Prove, Remove. Do not delete the old path helpers until the new path is
proven and the durable-data question is answered.

### Phase 1: Build the new resolver and declaration

- [ ] **1.1** Add `MountResources` / `MarkdownResource` types and `resources?:` to
  `Mount` in `daemon/define-mount.ts`.
- [ ] **1.2** Add `ResolvedMountResources` + `resolveMountResources()` in a new
  `daemon/mount-resources.ts` (replaces `document/workspace-paths.ts`).
- [ ] **1.3** Add `resources: ResolvedMountResources` to `MountContext` (the
  all-optional shape, Open Question 1 option a); have `openOneMount()`
  (`open-project.ts`) call `resolveMountResources(projectDir, mount)` and inject it.
- [ ] **1.4** Change `attachProjectSync` to take `yjsLogPath: string`
  instead of `projectDir`.
- [ ] **1.5** Validate `resources` in `loadProjectConfig`'s `isMount` boundary:
  `markdown.role` is a known literal, content `path` is relative and does not
  escape the project root. Return `ProjectConfigError.ProjectConfigInvalid`.

### Phase 2: Build the script surface

- [ ] **2.1** Add `loadProjectResources()` + `ProjectResources` / `ResolvedMount`
  in `client/load-project-resources.ts`, built on `loadProjectConfig` +
  `validateMountNames` + `resolveMountResources`.
- [ ] **2.2** Export `loadProjectResources` from `node.ts`.

### Phase 3: Switch every mount and consumer (stop importing the old path)

- [ ] **3.1** Fuji, Honeycrisp, Tab Manager: declare `resources`, read
  `ctx.resources.*.path`, drop the `sqliteFile` / `markdownDir` options, keep `git`.
- [ ] **3.2** `apps/opensidian`, `apps/zhongwen` (root-doc only): pass
  `yjsLogPath: ctx.resources.yjs.path`. Simple swaps.
- [ ] **3.3** `playground/opensidian-e2e` (NOT trivial: a fan-out daemon): declare
  `resources` (sqlite + markdown), swap the root `yjsPath` for `ctx.resources.yjs.path`,
  the materializer `sqlitePath`/`markdownPath` for `ctx.resources.{sqlite,markdown}.path`,
  and the per-row child-doc `yjsPath(projectDir, contentYdoc.guid)` for
  `ctx.resources.childDoc(contentYdoc.guid).path`. `playground/tab-manager-e2e`:
  same as the materializing apps. Collapse the `examples/fuji` config to `[fuji()]`.
- [ ] **3.4** `up.ts`: stop pre-creating type-major dirs; ensure `.epicenter/` and
  write `.gitignore` as `*`. Materializers already `mkdir` their parent on demand.
- [ ] **3.5** Rewrite `docs/scripting.md` and `packages/cli/README.md` reads section.

### Phase 4: Prove

- [ ] **4.1** Typecheck the workspace package and all apps.
- [ ] **4.2** Update / run `workspace-paths.test.ts` (now `mount-resources.test.ts`),
  `open-workspace-sqlite.test.ts` (now `load-project-resources.test.ts`),
  `up.test.ts` (gitignore content).
- [ ] **4.3** Smoke: `epicenter daemon up` in `examples/fuji`, then a script that
  does `loadProjectResources().mount('fuji').openSqlite()` and a `markdown_push`.

### Phase 5: Remove

- [ ] **5.1** Delete `resolveProjectPath`, `sqlitePath`, `markdownPath`, `yjsPath`
  from the old `document/workspace-paths.ts` (and the file if empty).
- [ ] **5.2** Delete `openWorkspaceSqlite` and its re-export from `node.ts`.
- [ ] **5.3** Grep for `workspaceId`-keyed path math, `.epicenter/sqlite/`,
  `markdownDir`, `sqliteFile`; confirm no stragglers outside historical specs.
  Sweep stale JSDoc that names the deleted helpers: `open-sqlite-reader.ts` (refs
  `sqlitePath(...)`), `materializer/sqlite/bun-sqlite.ts` (refs `sqlitePath(...)`),
  and the `MountContext` JSDoc in `define-mount.ts` ("helpers like `yjsPath` derive
  every absolute path from [projectDir]"), which becomes false.

---

## What to delete or deprecate

```txt
DELETE
  resolveProjectPath()            workspace-paths.ts   (the second owner)
  sqlitePath / markdownPath / yjsPath (workspaceId-keyed signatures)
      yjsPath's guid-keying CAPABILITY is not lost: it moves into
      ResolvedMountResources.childDoc(guid), scoped under the mount subtree.
  openWorkspaceSqlite()           open-workspace-sqlite.ts
  FujiMountOptions.sqliteFile / .markdownDir  (+ Honeycrisp, Tab Manager)
  examples/fuji overrides         markdownDir:'.', sqliteFile:'.epicenter/sqlite.db'
  up.ts type-major dir creation   .epicenter/{sqlite,yjs,md,log}/ pre-mkdir
  up.ts multi-entry .gitignore    ['sqlite/','yjs/','md/','log/']  ->  '*'

KEEP (unchanged)
  Mount[] contract, defineMount, loadProjectConfig's isMount (extended, not replaced)
  connectDaemonActions  (the live-action script mode)
  openReadonlySqlite / openSqliteReader  (primitives; ResolvedMount.openSqlite wraps them)
  daemon/paths.ts  (runtime files under env-paths)
  attachMarkdownMaterializer, attachBunSqliteMaterializer  (only their path arg source changes)
```

No aliases, no fallback parser, no dual readers. One model.

---

## Edge Cases

### Two content mounts whose table folders overlap

1. `[fuji(), notes()]` where both declare `markdown.role:'content'` and, after the
   base + table-name nesting, both write a `<base>/notes/` folder.
2. They would interleave files in the same tree and clobber each other.
3. Validate at config load: the resolved `<base>/<table>/` folder set must be
   disjoint across content mounts in one project. Structured `ProjectConfigError`.
   (Projection paths cannot collide; they are mount-named under `.epicenter/`.)

### Script runs before the daemon's first materializer snapshot

1. `openSqlite()` on a declared-sqlite mount whose `.epicenter/mounts/<name>/sqlite.db`
   does not exist yet.
2. Same as today: `openReadonlySqlite` throws "no such file."
3. Keep the existing clear error; it means "daemon has not written its first
   snapshot." Unchanged behavior.

### Mount declares `sqlite` but `open()` forgets to wire it

1. The directory stays empty; `openSqlite()` throws "no such file."
2. With the typed-narrowing variant (Open Question 1), `ctx.resources.sqlite` is
   non-optional, so the factory is nudged to wire it. Without it, this is a factory
   bug caught by the Phase 4 smoke test.

---

## Open Questions

1. **Type the `ctx.resources` shape to the declaration?**
   - Options: (a) `ctx.resources` is the all-optional `ResolvedMountResources`
     (factory uses `ctx.resources.sqlite!.path`); (b) a `const`-generic on
     `defineMount` narrows `ctx.resources` so a declared `sqlite: true` makes
     `ctx.resources.sqlite` non-optional (no `!`).
   - **Concrete obstacle for (b)**: `MountContext` is non-generic today, and
     `open` is a *method* in the literal passed to `defineMount`, so `ctx`'s type
     must be inferred from a sibling property (`resources`) of the same literal.
     That needs `MountContext<TResources>`, a `const TResources` param on
     `defineMount` (so `{ sqlite: true }` does not widen to `boolean`), and
     `open` typed as a function generic over the captured `TResources`. The
     cross-property inference fights `MaybePromise<TRuntime>` inference and is the
     fragile part.
   - **Recommendation**: ship (a) now (Phase 1.3); pursue (b) as a follow-up only
     if the `ctx.resources.sqlite!.path` assertions prove error-prone in practice.
     Do not block this spec on the generic.

2. **Does `loadProjectResources` throw or return `Result`?**
   - **Recommendation**: throw, to mirror `connectDaemonActions` (the sibling
     script-facing convenience). Library internals (`loadProjectConfig`) stay
     `Result`. Log as a Class 3 decision.

3. **Keep the `mounts/` segment, or `.epicenter/<name>/` directly?**
   - **Recommendation**: keep `mounts/`. It separates per-mount data from the
     `.gitignore` and any future `.epicenter/`-level files, and reads clearly when
     a human browses the folder. Revisit if nothing else ever lands at
     `.epicenter/` top level.

4. **Per-project override of a content path (e.g. `journal/` instead of `entries/`)?**
   - **Recommendation**: refuse until a concrete trigger (two projects of the same
     app needing different folders). `entries/` is Fuji's identity today. Earned-trigger
     test, not a hypothetical.

5. **One-time migration of existing on-disk data?** See Risks.

---

## Risks

### Durable-format change (the one to confirm before Phase 5)

`.epicenter/mounts/<name>/yjs.db` is a new home for the durable CRDT log. Moving it
orphans data at the old `.epicenter/yjs/<guid>.db`. This is a durable-storage change;
per clean-break rules, confirm before deleting the old layout.

```txt
Recovery paths that make the break low-risk:
  synced mounts        the Y.Doc re-syncs from cloud on next connect
  content mounts       the daemon rebuilds .epicenter/ from committed entries/*.md via markdown_push
  offline + no content the only at-risk case

Recommended safety net (Phase 0, optional but cheap):
  In `daemon up`, detect the old layout and move once:
    .epicenter/{yjs,sqlite,md}/<rootGuid>.*  ->  .epicenter/mounts/<name>/*
  Delete the mover after one release.
```

Child-doc wrinkle: the old layout stored root AND child Y.Doc logs flat under
`.epicenter/yjs/<guid>.db`, with no on-disk signal for which mount a child guid
belongs to. A pure-filesystem mover cannot attribute child guids to mounts. The
honest options are (a) move only root docs and let fan-out child docs re-sync from
cloud / rebuild on next access (recommended; child content docs are typically
resyncable), or (b) have each mount expose its child-guid set at startup for a
guided move (more code, only worth it for an offline fan-out mount with
irreplaceable child data). This is another reason fan-out mounts (Phase 3.3) are
the riskiest migration and should be smoke-tested explicitly.

**Class 1 action**: check whether any real user project has durable data at the old
paths today. The repo is recent (late May 2026) and the example config is still in
flux, so this may be dev-only. Verify, then choose: auto-migrate vs accept resync.

### Config import in the script process

`loadProjectResources` imports `epicenter.config.ts`, which imports the app package.
This is the same weight as today's `import { FUJI_ID } from '@epicenter/fuji'`, and
it is side-effect-free because `open()` is never called. Risk is low; flag only if a
config does real work at module top level (it should not; that is an anti-pattern to
call out in docs).

---

## Recommendation

**Implement now, as one clean-break PR staged in Build / Prove / Remove waves.** Not
a prototype: there is no UI or UX unknown, the materializer already supports both
markdown directions, and the design is a direct collapse of an existing dual-owner
bug. Not a long-lived multi-PR split either: a hybrid that keeps both the override
convention and the new declaration alive would reintroduce the exact "two owners"
smell this spec removes.

The one gate before the Remove wave is the durable-data check (Risks). Everything
through Phase 4 is reversible with a single revert; Phase 5 deletion waits on that
evidence.

The asymmetric win, stated plainly: declaring resources and refusing projection
overrides deletes `resolveProjectPath`, three `?? convention` fallbacks, the
`sqliteFile`/`markdownDir` options across three apps, the `openWorkspaceSqlite`
convention coupling, the gitignore-escape bug, and the mount-vs-workspaceId script
seam, in exchange for one cosmetic loss (a project can no longer relocate a
projection to an arbitrary path). The product sentence survives without an "or."

---

## References

- `packages/workspace/src/daemon/define-mount.ts` - add `resources` to `Mount`, host `MountResources`
- `packages/workspace/src/daemon/mount-resources.ts` - new: `resolveMountResources` (replaces `workspace-paths.ts`)
- `packages/workspace/src/workspace-apps/open-project.ts` - inject `ctx.resources`
- `packages/workspace/src/daemon/attach-project-sync.ts` - take `yjsLogPath`
- `packages/workspace/src/config/load-project-config.ts` - validate `resources` at the boundary
- `packages/workspace/src/client/connect-daemon-actions.ts` - the live-action sibling (pattern to mirror)
- `packages/workspace/src/document/open-workspace-sqlite.ts` - delete; replaced by `loadProjectResources`
- `packages/workspace/src/document/materializer/markdown/materializer.ts` - bidirectional reality (`markdown_push`)
- `apps/{fuji,honeycrisp,tab-manager,opensidian,zhongwen}/project.ts` - declaration call sites
- `playground/opensidian-e2e/workspaces/opensidian/daemon.ts` - fan-out daemon; child-doc persistence to migrate via `childDoc()`
- `apps/fuji/fuji.workspace.ts` - `entryContentDocs` fan-out via `createDisposableCache` (browser-persisted today)
- `examples/fuji/epicenter.config.ts` - collapses to `[fuji()]`
- `packages/cli/src/commands/up.ts` - gitignore + dir creation simplification
- `docs/scripting.md`, `packages/cli/README.md` - rewrite the reads section
- `specs/20260528T121508-config-force-mount-array.md` - the settled `Mount[]` contract (do not reopen)
- `specs/20260527T120000-project-folders-and-control-plane-vision.md` - Q3/Q4 this spec answers
