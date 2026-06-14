# App Folder As Epicenter Root, Distributed As jsrepo Blocks

**Date**: 2026-06-14
**Status**: Draft
**Owner**: Braden
**Supersedes (in part)**: `20260612T000201-epicenter-namespace-root-layout.md` (the "one root holds many mount projections as direct children" model), `20260528T121508-config-force-mount-array.md` (the `Mount[]` cardinality decision)

## One Sentence

Each app is its own Epicenter root: a self-contained folder that holds a singular `epicenter.config.ts`, owns its `.epicenter/` machine state, and is installed and updated as one vendored jsrepo block.

## How to read this spec

```txt
Read first:
  One Sentence
  The Topology Decision
  Target Shape
  Invariants

Read if changing code:
  Call Sites (grounded against origin/main)
  Implementation Plan
  Edge Cases

Decision context:
  Why This Over The Coarse Root
  jsrepo Distribution Model
  Rejected Alternatives
  Open Questions
```

## The Topology Decision

The previous layout spec made one folder (the "Epicenter root") hold a `Mount[]`
config and project every mount into a direct child folder, served by one daemon.
This spec inverts the granularity:

> The Epicenter root is the app folder itself. One folder, one
> `epicenter.config.ts`, one mount, one `.epicenter/`, one daemon.

The config returns to singular (`export default fuji()`), which is the shape
`#1957` reached for but could not justify while the runtime stayed plural. With
the topology now genuinely per-folder, singular config is the correct shape and
the runtime simplifies to match.

This is chosen for one dominant reason: **distribution.** Apps are meant to be
browsed in a registry and installed with one command. A self-contained folder is
a drop-in unit; a coarse root forces a post-install edit to a shared array that
the installer cannot perform for you.

## Target Shape

After `jsrepo add fuji` in a workspace container:

```txt
my-workspace/                 unreserved container (NOT an Epicenter root)
  fuji/                       the Epicenter root (one jsrepo block)
    epicenter.config.ts       tracked    export default fuji()
    project.ts                tracked    the mount factory (vendored)
    index.ts                  tracked    createFuji, schema, actions (vendored)
    entry-body-markdown.ts    tracked    (vendored)
    .gitignore                tracked    optional; generated dirs self-ignore
    .epicenter/               IGNORED    yjs/<guid>.db, sqlite/<guid>.db, md/ (machine state)
    entries/                  IGNORED    human-readable .md projection (per content table)
  honeycrisp/
    epicenter.config.ts       export default honeycrisp()
    ...
```

Daemon runtime files (lease, socket, metadata) are NOT in the folder. They
already live in the per-user `run/` dir keyed by a hash of the root
(`daemon/paths.ts`), so N roots coexist with no change.

The framework (`@epicenter/workspace`, `@epicenter/encryption`,
`@epicenter/identity`) stays an npm dependency. Only the app-specific source
(schema, actions, mount factory) is vendored. This is the shadcn split: React
stays npm, the component is vendored.

## Vocabulary

```txt
Epicenter root     The app folder that holds epicenter.config.ts. One per app.
Mount              The single app this root runs. Its `name` is the action
                   namespace (`fuji.<action>`), NOT a path segment anymore.
Block              One app folder as a unit in a jsrepo registry.
Container          Any folder holding sibling app folders. Not itself a root.
Vendored source    App code copied into the folder by jsrepo (you own it).
Projection         The read-only .md materialization, per content table, under
                   the root. Generated; self-ignored from git.
```

## Invariants

1. `epicenter.config.ts` default-exports a single `Mount`. A `Mount[]` is a
   structured `EpicenterConfigInvalid` pointed at the file. (Reverts force-array.)
2. The Epicenter root owns its own `.epicenter/`. Deleting the folder removes all
   of the app's local state. No shared state dir across apps.
3. Discovery stays **upward-only** (`findEpicenterRoot` unchanged). A normal
   command resolves exactly one root by walking up. Multi-app fan-out is a
   separate, explicit, opt-in command that is the only thing allowed to scan down.
4. Generated directories self-ignore: each writes its own `.gitignore` containing
   `*`. Vendored source is tracked because nothing hides it. No root-level
   allowlist (`/*` except config) that would hide vendored source.
5. The mount name is the action namespace, not a folder name. The visible
   projection structure comes from content-table names, not the mount name.

## Why This Over The Coarse Root

| Dimension | Coarse root (superseded) | App-folder root (this spec) |
|---|---|---|
| Install | `jsrepo add` + hand-edit the central array | `jsrepo add` only; folder is self-contained |
| Config shape | `Mount[]` (array-of-one in practice) | singular `Mount` |
| State deletion | rm folder + sweep guid-keyed files in shared `.epicenter/` | `rm -rf folder` is total |
| Fault isolation | logical (one process) | physical (one daemon per app) |
| LLM/human navigation | shared array + npm-package internals | one folder holds the whole app |
| Cross-app queries | one socket | opt-in orchestrator fan-out |
| Discovery | upward-only, one answer | upward-only preserved; fan-out opt-in |

The honest cost: "run all my apps at once" needs an orchestrator (deferred,
opt-in), and vendored code means `jsrepo update` can conflict with local edits
(the accepted shadcn bargain).

## jsrepo Distribution Model

Grounded against `jsrepojs/jsrepo` via DeepWiki:

- A block can be a whole folder: `subdirectory: true` in the block manifest plus
  `allowSubdirectories: true` in `jsrepo-build-config.json`. All files land
  together in a named folder in the consumer repo.
- A block declares npm deps (`dependencies`/`devDependencies`) and block deps
  (`localDependencies`). `jsrepo add` installs the npm packages and recursively
  pulls dependent blocks.
- jsrepo **rewrites relative imports** (via oxc-parser) when it vendors a folder,
  so `./project.js` keeps resolving in the consumer's chosen path.
- Registry repo shape: `dirs: ["./src"]`, one folder per block, build emits
  `jsrepo-manifest.json`, `publish` ships it.

Caution on `localDependencies`: pulling a shared helper block into multiple app
folders re-introduces divergeable copies and fights self-containment. Keep shared
logic in `@epicenter/workspace` (npm, single source); use `localDependencies`
only for genuinely per-copy code.

## Call Sites (grounded against origin/main)

Coupled to the coarse-root invariants today:

```txt
PROJECTION CONVENTION  <root>/<mountName>
  packages/workspace/src/document/workspace-paths.ts  mountMarkdownPath()
  packages/workspace/src/workspace-apps/open-epicenter-root.ts:243  findPopulatedMountFolder
  apps/fuji/src/lib/workspace/project.ts:57            mdDir = mountMarkdownPath(root, mount)
  apps/honeycrisp/project.ts:40                        same
  apps/tab-manager/project.ts:39                       same

CARDINALITY  Mount[] end to end
  packages/workspace/src/config/load-epicenter-config.ts        returns Result<Mount[]>; rejects bare Mount
  packages/workspace/src/workspace-apps/open-epicenter-root.ts  Promise.allSettled fan-out, {started[], inactive[]}
  packages/workspace/src/daemon/mount-validation.ts             validateMountNames (duplicate + format)
  packages/cli/src/commands/up.ts:155                           runUp consumes OpenedEpicenterRoot
  packages/cli/src/commands/init.ts                             scaffolds export default []

GITIGNORE  root allowlist
  packages/workspace/src/workspace-apps/open-epicenter-root.ts:227  ROOT_GITIGNORE (/* except config)
  packages/workspace/src/workspace-apps/open-epicenter-root.ts:270  .epicenter/.gitignore = *  (keep)
  packages/workspace/src/document/materializer/markdown/export.ts:194  mkdir(baseDir) (hook for per-dir self-ignore)

DISCOVERY  upward-only (KEEP, no change)
  packages/workspace/src/client/find-epicenter-root.ts
  packages/cli/src/util/common-options.ts:18  -C coerce
  packages/workspace/src/client/connect-daemon-actions.ts:52

DAEMON PATHS  already per-root (NO CHANGE)
  packages/workspace/src/daemon/paths.ts  lease/socket/metadata keyed by root hash in run/
```

## Implementation Plan

Sequenced so each wave is independently shippable and reviewable.

### Wave 1: Projection convention + gitignore (behavior-preserving prep) [landed in #1980]

1. Change the projection to root-relative. Mount factories pass `dir:
   epicenterRoot` (or a chosen content dir), letting the exporter's per-table
   subdir (`config.dir ?? table.name`) provide the visible structure
   (`fuji/entries/`, not `fuji/fuji/`). Update `mountMarkdownPath` to identity
   or delete it; update fuji, honeycrisp, tab-manager.
2. Exporter writes `<tableDir>/.gitignore` containing `*` when it creates/rebuilds
   a table directory (`export.ts` near the `mkdir`). Generated projection
   self-ignores without an allowlist.
3. Remove the root `ROOT_GITIGNORE` allowlist write from `claimEpicenterFolder`.
   Keep `.epicenter/.gitignore = *`. The jsrepo block MAY ship a tracked
   `.gitignore` for belt-and-suspenders, but vendored source is tracked by default.

### Wave 2: Cardinality collapse (the #1957 idea, rebuilt against current main) [landed in #1980]

4. `loadEpicenterConfig` returns `Result<Mount>`. Accept a bare `Mount`, reject a
   `Mount[]` with a pointer to unwrap it. Move format validation
   (`isValidMountName`) here (the only place that can point at the file).
5. `openEpicenterRoot` opens the one mount and returns a discriminated
   `Result<StartedMount | InactiveMount>` (NOT a single `StartedMount`: the
   auth-optional/inactive model means one mount has three outcomes). Drop the
   `Promise.allSettled` fan-out and the `dispose-siblings` loop.
6. `validateMountNames` collapses to single-name format validation; duplicate
   detection is dead (one config cannot collide with itself; cross-folder names
   are disambiguated by folder, not name).
7. `runUp` consumes the single outcome. `init` scaffolds a comment-only singular
   template. Update the 4 in-repo configs to `export default fuji()` etc.

### Wave 3: Fan-out (opt-in, deferred until Wave 4 creates multiple installed apps)

The teardown and visibility sides are ALREADY container-global: `daemon ps`
enumerates every running daemon for the user (`enumerateDaemons` over the runtime
metadata dir) and `daemon down --all` stops them all in parallel. Only `up` is
still single-root. Wave 3 closes that asymmetry by giving `up` the same fan-out
the other two verbs already have.

The one genuinely-new capability is downward discovery. `ps` / `down --all`
enumerate RUNNING daemons from runtime metadata, but nothing is running before
`up`, so `up --all` must enumerate ROOTS ON DISK by scanning down a container for
`epicenter.config.ts`. Everything else (spawn, signal, teardown) reuses the
existing single-root `daemon up`.

8. Keep `findEpicenterRoot` upward-only. Add the explicit, opt-in scan-down
   command. Decisions settled (2026-06-14):
   - Process model: a FOREGROUND SUPERVISOR that spawns one child
     `epicenter daemon up -C <root>` per discovered root, multiplexes their
     stderr, propagates SIGINT/SIGTERM, and reports per-child health. Child
     processes (not N mounts in one process) preserve the physical fault
     isolation that is this topology's headline benefit, and reuse the
     single-root lifecycle (lease, socket, metadata, teardown) unchanged.
   - Partial failure: start-healthy-and-report. Start every root, keep the
     healthy children running, report which failed and why; do not tear the
     fleet down because one app failed to open.
   - Discovery: this `--all` scan is the ONLY scan-down path. It descends from
     the cwd container, stops descending at the first `epicenter.config.ts` on
     each branch (a root is a leaf for this scan), and skips `.epicenter`,
     `node_modules`, and `.git`.
   - Naming forks on Open Question 2 (see below). A thin CLI fan-out is
     `epicenter daemon up --all`, where `--all` is a PURE DISPATCH to a separate
     `runSupervisor()`: it does not generalize `runUp`, so the single-root
     `UpHandle` return is untouched and the array-of-one overload never returns.
     A graduated control-plane gets its own noun, ultimately the app, not a flag.

   Gate: defer until there are multiple installed apps to supervise. That
   condition is downstream of Wave 4 (distribution), so Wave 4 precedes real
   Wave 3 demand.

### Wave 4: jsrepo registry (BLOCKED on the npm publish pipeline)

Audited 2026-06-14: the premise that "the framework stays an npm dependency;
`jsrepo add` installs the npm packages" does NOT hold today. `jsrepo add fuji`
cannot work end to end because the framework it would `npm install` is currently
uninstallable. Two independent defects:

DEFECT 1, incomplete publish set. `@epicenter/workspace` depends on
`@epicenter/encryption`, `@epicenter/field`, `@epicenter/identity`,
`@epicenter/sync`, `@epicenter/util`. Of these, `encryption`, `field`, `util`
are `private: true` (so changesets skips them) and `identity` is non-private but
was never given a changeset; all four are 404 on npm. Only `sync` and `workspace`
are published. So installing `@epicenter/workspace` pulls four 404s.
(`@epicenter/constants`, also `private: true`, blocks other apps the same way.)

DEFECT 2, bun protocol strings ship unresolved. The published
`@epicenter/workspace@0.1.0` manifest declares deps verbatim as
`'@epicenter/sync': 'workspace:*'` and `wellcrafted: 'catalog:'`. The release
path is `changeset version && changeset publish` (changesets over npm, per
`.github/workflows/README.md`, which says not to run `bun publish` directly).
`changeset version` rewrites `workspace:*` for managed packages, but `catalog:`
is a bun-only protocol that neither changesets nor `npm publish` resolves, and no
prepack step rewrites it. Every published `@epicenter/*` package with a
`catalog:` dep therefore has a broken manifest.

The block candidate is `examples/fuji/` (a clean Epicenter root:
`epicenter.config.ts` + `export default fuji()`, its own gitignore and tsconfig),
NOT the SvelteKit `apps/fuji`. But `examples/fuji` is stale: it predates this
spec's merge (its `.gitignore` ignores the old `/fuji/` mount-name projection
instead of the per-table `entries/` dir, and it cites the superseded layout spec
`20260612T000201`). It needs a Wave 1 refresh regardless.

Phased plan:

9. PHASE 0 (prerequisite, the bulk of the work): make the `@epicenter/*` runtime
   closure installable from npm. Two sub-decisions:
   - Publish-the-closure vs bundle-the-closure. Either un-`private` and publish
     `encryption`, `field`, `identity`, `util` (add them to the changesets
     `fixed` group), or bundle them into `@epicenter/workspace` at build time so
     they stop being separate npm deps. The spec names workspace, encryption, and
     identity as the public framework, which argues for publishing those and
     bundling the rest (`field`/`util` are implementation detail).
   - Resolve `catalog:` (and any stray `workspace:*`) at publish: a catalog
     rewrite step before `changeset publish` (a prepack rewrite, a changesets
     catalog plugin, or a bun-publish-based tag step). Verify
     `npm install @epicenter/workspace` in an empty dir actually resolves.
   Until Phase 0 is green nothing downstream works, and the broken published
   packages are a latent problem independent of jsrepo.
10. PHASE 1 (jsrepo mechanics, de-riskable now WITHOUT npm): build the block over
    a refreshed `examples/fuji`-shaped source with `allowSubdirectories: true`
    and a `subdirectory: true` manifest, against locally-linked deps. Prove
    vendoring rewrites relative imports and the gitignore story holds (vendored
    source tracked; `.epicenter/` and `entries/` self-ignored).
11. PHASE 2 (end to end, needs Phase 0 + 1): `jsrepo add fuji` in a real external
    project; npm installs the framework; `epicenter daemon up` runs inside the
    vendored folder. Validate on a fresh clone. This is the spec acceptance test.
12. PHASE 3: convert honeycrisp, tab-manager, and the notes example to blocks.

## Edge Cases

- **clientID base.** `hashYDocClientId(path)` derives from the root path. More
  roots means more distinct clientIDs, which is correct. Verify nothing assumed a
  shared clientID across mounts in one root.
- **Cross-folder duplicate mount names.** Allowed: each folder is its own daemon
  with its own socket, so `notes.` addresses do not collide. Only the opt-in
  orchestrator must disambiguate, and it does so by folder.
- **Container is not a root.** Running `epicenter up` from `my-workspace/` (no
  config) must error with a clear "cd into an app or use `--all`" message, not
  silently scan.
- **Route-by-name with one mount.** The `<mount>.<action>` prefix is now always
  single-mount. Keeping it preserves the client addressing API; dropping it is a
  consumer-facing change. Default: keep. (Open question.)

## Rejected Alternatives

- **Keep the coarse root + force-array.** Rejected: it makes jsrepo install a
  two-step (copy + hand-edit the array) and keeps the array-of-one smell. The
  coarse model's only real win (cross-app queries in one socket) is recovered by
  the opt-in orchestrator.
- **Resurrect #1957's diff.** Rejected: built on pre-rename file paths and a
  pre-inactive return type (single `StartedMount`). The idea is rebuilt in Wave 2;
  the diff is dead.
- **Vendor the framework too.** Rejected: `@epicenter/workspace` is large and
  shared; vendoring it defeats updates. Framework stays npm.

## Open Questions

1. Projection visibility: gitignore the generated `.md` (default here) or let
   users commit their notes? Leaning gitignore + an explicit "export to tracked
   folder" action later.
2. `--all` orchestrator: a thin CLI fan-out vs the separate control-plane app.
   This fork is still live, and it controls Wave 3's NAME and whether the CLI
   version is throwaway. Settled regardless of the fork (see Wave 3):
   child-process supervision, start-healthy-and-report, and the downward-discovery
   rules. What the fork still decides: if a control-plane app is coming
   (persistent fleet state, auto-restart / start-on-login policy, a health UI,
   cross-app queries through one surface), then a CLI `up --all` is throwaway
   scaffolding and we should skip to the app. If "bring my apps up in one terminal
   for dev" is the whole need, the `daemon up --all` dispatch is the complete
   answer. Not decidable without living with multiple installed apps, which is the
   Wave 3 gate.
3. Keep the single-mount action prefix, or drop it for ergonomics?
4. Registry hosting: GitHub-backed registry vs a custom HTTP registry for the
   first-party blocks.
