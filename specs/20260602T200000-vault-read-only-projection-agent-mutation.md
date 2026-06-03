# Vault as Read-Only Projection: Agent Mutation Through Actions

**Date**: 2026-06-02
**Status**: In Progress (monorepo Phases 1, 2, 5 implemented; vault Phases 3, 4 pending the monorepo code reaching the sibling `../epicenter` checkout the vault imports)
**Owner**: Braden
**Supersedes (in part)**: `20260602T120000-markdown-body-import-bidirectional.md`, `20260601T160000-markdown-sync-greenfield.md`, `20260601T120000-epicenter-apply-markdown-reconcile.md` (this spec refuses the disk to Yjs editing path those introduced, for app-owned data)

## One Sentence

An Epicenter vault is a folder where `apps/` is a read-only, one-way markdown projection of app data owned by Yjs, `.epicenter/` is hidden machine state, and everything else is the user's own plain markdown; the only way to mutate app data, for humans and coding agents alike, is through validated actions reached via the CLI (and an optional MCP adapter later), never by editing the materialized files.

## How to read this spec

```txt
Read first:
  One Sentence
  The Vault Layout
  The Config Decision
  Verification

Read if changing the architecture:
  Verified File Inventory
  Migration Plan
  Edge Cases

Decide these:
  Open Questions
```

## Overview

The vault holds three kinds of content with three different owners:

| Content | Owner | Audience | Home | Tracked? |
| --- | --- | --- | --- | --- |
| `epicenter.config.ts` | you (declares mounts) | you | root, like `package.json` | tracked |
| `apps/**.md` | the daemon (materializer) | **your eyes** (read/curate) | `apps/`, visible, like `dist/` | gitignored |
| sqlite / yjs / socket / manifest | the daemon | nobody (machine reads it) | `.epicenter/`, hidden, like `node_modules/` | gitignored |
| `journal/`, `ideas/`, anything else | you | you | root | tracked |

Mutating app data happens only through validated actions, surfaced to coding agents through the existing CLI. This refuses collaborative editing of materialized files, which deletes the entire bidirectional disk to Yjs reconcile subsystem.

## The Vault Layout

```txt
vault/
├── epicenter.config.ts     YOURS. user-authored manifest (like package.json). tracked.
├── AGENTS.md  CLAUDE.md     YOURS. the read-only rule + CLI discover/mutate recipe.
├── .gitignore              ignores  .epicenter/  and  apps/
├── apps/                    MACHINE, VISIBLE. read-only projection of Yjs. gitignored.
│   ├── fuji/
│   │   └── entries/         one .md per entry
│   └── tab-manager/
│       ├── bookmarks/  devices/  savedTabs/
├── .epicenter/             MACHINE, HIDDEN. never hand-touched. gitignored.
│   ├── sqlite/             per-app relational mirrors (queried, not read as text)
│   ├── yjs/                local CRDT persistence
│   ├── sockets/            daemon unix socket
│   └── manifest.json       daemon-published mount manifest
├── journal/                YOURS. plain markdown. Epicenter is blind to it.
└── ideas/                  YOURS.
```

This is the universal project skeleton, so it needs no explaining:

```txt
epicenter.config.ts  ≈  package.json     (authored, tracked, root)
apps/                ≈  dist/            (generated, visible, gitignored)
.epicenter/          ≈  node_modules/    (machine, hidden, gitignored)
journal/  ideas/     ≈  src/             (yours, authored, tracked)
```

### The one rule (humans and agents)

```txt
Read apps/** freely. Never hand-edit it: it is regenerated; mutate via `epicenter run`.
Ignore .epicenter/.
Everything else in the vault is yours; edit it freely.
```

### Why two machine prefixes, not one

The instinct to put everything machine-owned under a single `.epicenter/` fails on one axis: **does a human read this file directly, as a file?**

```txt
apps/**.md        a human READS it (triage, curate, grep, diff)   → VISIBLE
.epicenter/*.db   a machine QUERIES it (you never open the .db)     → HIDDEN
.epicenter/yjs    a machine loads it                                → HIDDEN
```

Both markdown and sqlite are read-only projections of the same Yjs data. They split on readability, not on "is it generated." Markdown is output *for human eyes*, so it must be visible (Obsidian and Finder hide dotfolders; even where a tool like VS Code shows them, the dot-prefix *signals* "infra you ignore," which is the wrong signal for content you browse). SQLite is output *for machine queries*, so it belongs with the hidden state. That single axis is why the layout is two prefixes, not one.

## The Config Decision (collapse the knobs, hardcode the layout)

The vault layout (`apps/<name>` visible, `.epicenter/` hidden) is part of what an Epicenter vault *is*, the way `.git/` is part of what a git repo is. So it is a **hardcoded constant, not configuration.** The mount factories stop taking freeform paths and always materialize to:

```txt
apps/<mountName>/                  markdown projection   (visible, keyed by MOUNT NAME)
.epicenter/sqlite/<workspaceId>.db sql mirror            (hidden, keyed by ydoc.guid, unchanged)
.epicenter/yjs/<workspaceId>.db    crdt log              (hidden, keyed by ydoc.guid, unchanged)
```

Only **markdown** moves: from the hidden `.epicenter/md/<guid>` default to a visible `apps/<mount>`,
keyed by mount name so the folder reads `apps/fuji`, not `apps/epicenter-fuji`. **yjs and sqlite are
NOT re-keyed.** yjs is the durable source of truth (the daemon resolves it via `yjsPath(projectDir,
ydoc.guid)` in `attach-project-infrastructure.ts`); re-keying it would orphan local data and boot the
workspace empty offline. sqlite is a regenerable mirror keyed by guid via the existing `sqlitePath`
default; leaving it is the lowest-churn choice. Removing the freeform `sqliteFile` option just means it
falls back to that guid default instead of the vault's old `fuji.db` override (regenerates, harmless).

The config collapses to just the mount list:

**Before** (`vault/epicenter.config.ts`):

```ts
export default [
  fuji({ markdownDir: 'fuji', sqliteFile: '.epicenter/sqlite/fuji.db' }),
  tabManager({ markdownDir: 'tab-manager', sqliteFile: '.epicenter/sqlite/tab-manager.db' }),
];
```

**After**:

```ts
export default [ fuji(), tabManager() ];
```

The daemon writes `apps/fuji`, `apps/tab-manager`, `.epicenter/sqlite/fuji.db`, etc. Zero path config. Mount name (`'fuji'`) is the key, not `ydoc.guid`, so the folder is `apps/fuji`, not `apps/epicenter-fuji`.

### Why hardcode, not "freeform path + convention"

An earlier draft kept the freeform `markdownDir` and just pointed it at `apps/fuji` by convention. **That is a data-loss foot-gun.** The export seam's rebuild action (`markdown_export_rebuild` in `export.ts:190`) does `readdir + unlink every .md` in the target dir, then rewrites (`shared.ts:208` `rebuildTable`). A freeform `markdownDir: '../journal'` or `markdownDir: 'notes'` turns a routine rebuild into deletion of hand-authored markdown, exactly the data loss this spec refuses. A convention does not encode the invariant; a constant does. (Surfaced in Codex grilling.)

Note on the action name: `export.ts` calls it `markdown_export_rebuild`, deliberately distinct from vault's `markdown_rebuild` so a workspace could compose both seams. Once `vault.ts` is deleted there is only one seam, so **rename `markdown_export_rebuild` -> `markdown_rebuild`** (the disambiguation reason is gone). Update the CLI comment and any docs to the single name.

Worse, the current default is `markdownPath()` = `.epicenter/md/<guid>` (hidden); visibility today *requires* the override. Hardcoding `apps/<mountName>` makes visible-and-safe the default, with no override to misuse.

### Two rejections

```txt
Candidate: a { projectionRoot, mounts } config object owning the root.
Refusal:   overclaims (sqlite is also a projection but lives in .epicenter/, so the name lies);
           adds a concept + a config-shape break for a knob nobody needs.
           Codex agreed: "no public knob unless you can name a real product operation for changing it."

Candidate: freeform markdownDir / sqliteFile on the mount factories.
Refusal:   data-loss via rebuild (above); the override's only purpose is to point markdown
           somewhere other than apps/<name>, which is precisely what must be impossible.
           Removing it is a COLLAPSE (fewer options), not an addition.

Trigger to add a knob back: untrusted third parties author mount configs, or multi-tenant
hosting where one mount escaping the root corrupts another's data.
```

### Where flexibility still lives (the blog-export case)

The freeform `dir` stays on the **`attachMarkdownExport` primitive**, because a non-vault export (e.g. a published blog writing `content/posts/`) legitimately targets its own output dir. Rebuild deleting and rewriting *that* dir is correct, it is the tool's own output, not user-authored. The opinion is at the **mount-factory** layer (vault apps always use `apps/<name>`); the **primitive** stays flexible. Primitive flexible, product opinionated.

There is no `projectionRoot`/`markdownRoot` knob to name, `apps/` is a constant in the workspace lib (`workspace-paths.ts`).

## Capture, curate, keep (the graduation flow)

```txt
app captures -> materializes into apps/<name>/   (the inbox; disposable, regenerable from Yjs)
   -> you read it in VS Code / Obsidian / grep
      -> worth keeping? copy into journal/ or ideas/   (now YOURS, plain markdown forever)
         -> optionally stop the reprint by soft-deleting the source row via an action
```

The app zone is never the only copy of app data (Yjs is); user zones are the only copy of curated stuff. So copying out is safe and moving is unnecessary.

## Architecture

The daemon owns everything; every mutation client is stateless and routes through one validated choke point.

```txt
coding agent (Claude Code / Codex / opencode)
  -> reads apps/**.md freely        (great context, searchable, di- and grep-able)
  -> to MUTATE: epicenter run <mount>.<action> <json>   (Bash)
       -> daemon unix socket  POST /invoke
            -> invokeAction (TypeBox strict, no coercion)
                 -> Yjs action -> materialize -> apps/<name>/*.md refreshes
  -> to DISCOVER: epicenter list --format json          (per-action TypeBox schemas)

human in VS Code / Obsidian
  -> edits user zones (journal/, ideas/) freely        (plain markdown, untracked by Epicenter)
  -> reads apps/** as a printout; graduates good items by copying into a user zone
```

### The existing invocation surface (verified, unchanged by this spec)

| Surface | Exists? | Location |
| --- | --- | --- |
| `epicenter run <mount>.<action> [json]` (JSON via arg/`@file`/stdin, JSON out) | YES | `packages/cli/src/commands/run.ts` |
| `epicenter list [path] --format json` emitting full TypeBox input schemas | YES | `packages/cli/src/commands/list.ts` |
| `invokeAction` single validated choke point (TypeBox `Value.Check`, strict, no coercion) | YES | `packages/workspace/src/shared/actions.ts` |
| `daemon.list()` / `daemon.invoke()` over the unix socket | YES | `packages/workspace/src/daemon/client.ts` |

The CLI is already a complete agent tool surface: `list --format json` is structured discovery, `run` is structured invocation. MCP would add native in-context tool visibility but is net-new and additive; it is deferred.

## Verified File Inventory (the deletion + keep surface)

All paths verified in this worktree. Note: this is the post `vault/export` split layout (`vault.ts` / `export.ts` / `shared.ts`), NOT a single `materializer.ts`.

### Delete whole files

```txt
packages/workspace/src/document/materializer/markdown/
├── vault.ts                 the bidirectional attacher + apply/push/pull
├── vault.test.ts
├── apply.test.ts
└── reconcile-e2e.test.ts    two-peer markdown_apply e2e
```

### Keep whole files

```txt
packages/workspace/src/document/materializer/markdown/
├── export.ts                attachMarkdownExport: the one-way seam (finally gets consumers)
├── export.test.ts
├── git-autosave.ts
├── git.test.ts
└── slug-filename.ts
```

### Simplify in place

```txt
shared.ts   Shared by BOTH seams (materializeTable, rebuildTable). Remove the `protectLocalEdits`
            parameter and the dirty-guard block inside `writeRow` (the lines that read the on-disk
            file and skip the write when it diverged). KEEP `fileState` and the `FileState` type:
            the rename-cleanup branch (unlink the previous filename when it changes) still needs it.

index.ts    Drop the vault exports: attachMarkdownVault, ApplyPlan, MarkdownApplyError,
            MarkdownReadError, MarkdownVault, VaultTableConfig, VaultTablesConfig. Keep the
            attachMarkdownExport, git-autosave, and MarkdownShape exports.

apps/fuji/src/lib/workspace/project.ts
            MIGRATE attachMarkdownVault -> attachMarkdownExport. Delete the import-direction wiring:
            the `writeEntryBody` / `writeRoomOverHttp` + `parseEntryBody` apply path and the per-table
            `writeBody`/`onDelete` callbacks. KEEP the read direction: `readEntryBody` (which uses
            serializeEntryBody) becomes the export's `toMarkdown` body.

apps/fuji/src/lib/workspace/entry-body-markdown.ts
            Drop the parse half: parseEntryBody, the tokenizer, and the MarkdownParser. KEEP
            serializeEntryBody (the export renders the body with it) and entry-body-schema.

apps/fuji/src/lib/workspace/entry-body-markdown.test.ts
            Drop the parse / round-trip tests. Keep the serialize tests.

apps/honeycrisp/project.ts        MIGRATE attachMarkdownVault -> attachMarkdownExport.
apps/tab-manager/project.ts       MIGRATE attachMarkdownVault -> attachMarkdownExport.

packages/cli/src/cli.ts           Update the markdown_apply example comment.

packages/workspace/src/document/workspace-paths.ts
            ADD `appsMarkdownPath(projectDir, mountName)` -> `<projectDir>/apps/<mountName>` and
            export it from `@epicenter/workspace/node`. Do NOT flip or delete the existing
            `markdownPath` (playground daemons still import it); it can be removed in a later pass
            once those callers are gone. Leave `yjsPath` and `sqlitePath` untouched. Update
            `workspace-paths.test.ts` to cover `appsMarkdownPath`.

apps/{fuji,honeycrisp,tab-manager} mount factories
            Remove the freeform `markdownDir` / `sqliteFile` options from the *MountOptions types
            and their `resolveProjectPath(...) ?? ...` fallbacks. Materialize markdown to
            `appsMarkdownPath(projectDir, mount)` (visible apps/<mount>); let sqlite fall back to
            its guid-keyed `sqlitePath` default (do not re-key). Keep the `git` option. The
            flexible `dir` stays on the attachMarkdownExport primitive (non-vault exports need it).
```

### Doc + reference straggler sweep

`rg` for ALL of these names, not just `attachMarkdownVault`, and fix or remove each:

```txt
attachMarkdownVault   markdown_apply   protectLocalEdits   parseEntryBody   writeBody
ApplyPlan   MarkdownApplyError   MarkdownReadError   attachMarkdownMaterializer   markdownPath(
markdown_export_rebuild   (rename to markdown_rebuild)
```

Targets:

```txt
packages/workspace/README.md, packages/workspace/src/document/README.md
.agents/skills/{workspace-api,attach-primitive}/**     mentions of vault/apply/protectLocalEdits
docs/articles/one-sync-became-two-and-got-simpler.md   (decide: update or leave as historical)
specs/20260602T120000-*, specs/20260601T160000-*, specs/20260601T120000-*   mark superseded
playground/{tab-manager,opensidian}-e2e/.../daemon.ts  These import attachMarkdownMaterializer +
   markdownPath (NOT attachMarkdownVault), and are e2e scaffolds, not the product vault. Leave them
   on markdownPath (do not force apps/); do not delete markdownPath while they import it. If
   attachMarkdownMaterializer already fails to resolve, that is pre-existing and out of scope.
```

### Key correction to the original premise

All three apps (`fuji`, `honeycrisp`, `tab-manager`) **currently use `attachMarkdownVault`**; `export.ts` exists but has **no app consumers yet**. So this is not "delete an unused subsystem." The real work is **finishing the migration `export.ts` was built for**, then deleting `vault.ts`.

## Migration Plan (one app, before/after)

The per-table config changes from the vault's read+write shape to the export's render-only shape.

**Before** (`fuji` with `attachMarkdownVault`):

```ts
const markdown = attachMarkdownVault(workspace, {
  dir: mdDir,
  tables: {
    entries: {
      readBody: (entry) => readEntryBody(entry),              // KEEP (read direction)
      writeBody: (id, md) => writeEntryBody(asEntryId(id), md), // DELETE (import direction)
      onDelete: (id) => { /* tombstone */ },                   // DELETE (apply hook)
      // ...
    },
  },
});
```

**After** (`fuji` with `attachMarkdownExport`):

```ts
// mdDir is now hardcoded to apps/<mountName>, no FujiMountOptions path override.
const mdDir = appsMarkdownPath(projectDir, mount); // join(projectDir, 'apps', mount)
const markdown = attachMarkdownExport(workspace, {
  dir: mdDir,
  tables: {
    entries: {
      filename: (e) => slugFilename(e),
      toMarkdown: async (e) => ({
        frontmatter: entryFrontmatter(e),
        body: await readEntryBody(e),   // reads the Yjs body, serializes via serializeEntryBody
      }),
    },
  },
});
```

The `writeBody` / `parseEntryBody` / `onDelete` import path is gone; the `readEntryBody` / `serializeEntryBody` read path stays and becomes the export body.

## Implementation Plan

The dependency chain forces migrate-then-delete: the apps depend on `vault.ts` today, so it cannot be deleted first.

### Phase 1: Migrate apps to the one-way export (Build + Prove)

- [x] **1.1** `workspace-paths.ts`: ADD + export `appsMarkdownPath(projectDir, mountName)` -> `apps/<mountName>`. Leave `markdownPath`/`yjsPath`/`sqlitePath` untouched. Add a `workspace-paths.test.ts` case.
- [x] **1.2** `fuji/project.ts`: swap `attachMarkdownVault` -> `attachMarkdownExport`; move the body read into `toMarkdown`; drop `writeBody`/`onDelete`/`writeEntryBody`/`parseEntryBody` wiring; remove the `markdownDir`/`sqliteFile` options; materialize markdown via `appsMarkdownPath(projectDir, mount)` and let sqlite fall back to its guid-keyed default (do not re-key yjs/sqlite).
  > **Note**: kept fuji's output byte-identical to the old vault (`{ ...entry }` frontmatter + default `${id}.md` filename + `entries/` subdir). No `slugFilename`/`entryFrontmatter` introduced (those were illustrative in the migration sketch and do not exist).
- [x] **1.3** `honeycrisp/project.ts` and `tab-manager/project.ts`: same swap + same option removal (simpler, no rich body).
- [x] **1.4** `fuji/entry-body-markdown.ts`: drop the parse half; keep `serializeEntryBody`.
- [x] **1.5** Gate: `bun run -F @epicenter/workspace typecheck` and the fuji app typecheck pass (also honeycrisp + tab-manager: 0 errors).

### Phase 2: Delete the bidirectional subsystem (Remove)

- [x] **2.1** Delete `vault.ts`, `vault.test.ts`, `apply.test.ts`, `reconcile-e2e.test.ts`.
- [x] **2.2** Simplify `shared.ts`: remove `protectLocalEdits` + the dirty guard; keep `fileState` for rename cleanup. Also removed the now-orphaned `readContentOrUndefined` helper and its `readFile` import.
- [x] **2.3** Simplify `index.ts`: drop the vault exports.
- [x] **2.4** Trim `entry-body-markdown.test.ts` to serialize-only.
  > **Note**: pulled into Phase 1's parser-removal commit so the fuji typecheck gate (1.5) stayed green (the test imported the deleted `parseEntryBody`).
- [x] **2.5** Rename `markdown_export_rebuild` -> `markdown_rebuild` in `export.ts` (vault's same-named action is gone, so the disambiguation is no longer needed); update the `cli.ts` comment and any doc references.
- [x] **2.6** Gate: `bun test` in `packages/workspace` (494 pass, 0 fail; export/git/materialize green; vault/apply gone).

### Phase 3: Vault restructure (in `~/Code/vault`)

> **Blocked**: the vault imports `fuji`/`tabManager` and the CLI from the sibling `../epicenter` checkout (= `/Users/braden/Code/epicenter`, main), not from this worktree. The `apps/` layout and the visible projection only appear once this PR's code is live there. Running 3.1b (deleting generated dirs) and the Phase 4 smoke test against the old code would mutate the real vault into an inconsistent state. Do after merge, or after pointing the vault at this worktree.

- [ ] **3.1** Create `apps/`; move `fuji/` -> `apps/fuji/`, `tab-manager/` -> `apps/tab-manager/`.
- [ ] **3.1b** Delete stale generated dirs so nothing looks authoritative after the re-key: any old `.epicenter/md/<guid>/` left by the hidden default, and the old `.epicenter/sqlite/fuji.db` / `tab-manager.db` (the new guid-keyed mirrors regenerate). These are all gitignored/regenerable; the daemon rebuilds `apps/` and `.epicenter/sqlite/` on next start. Do NOT touch `.epicenter/yjs/` (source of truth).
- [ ] **3.2** Simplify config to `export default [ fuji(), tabManager() ]` (paths are now hardcoded).
- [ ] **3.3** `.gitignore`: ignore `.epicenter/` and `apps/`.
- [ ] **3.4** Rewrite `AGENTS.md` (+ `CLAUDE.md` shim) with the one rule, the layout tree, and the CLI discover/mutate recipe; drop the soft-delete-by-hand guidance that referenced apply.

### Phase 4: Prove end-to-end (the gate before merge)

- [ ] **4.1** Start the daemon against the vault; `epicenter list --format json` discovers actions.
- [ ] **4.2** `epicenter run fuji.<update>` -> the `apps/fuji/*.md` file refreshes.
- [ ] **4.3** Hand-edit an `apps/fuji/*.md` file -> the next materialize overwrites it cleanly; nothing breaks; Yjs is unchanged.

### Phase 5: Straggler sweep

- [x] **5.1** Update README / skills / cli.ts comment; mark superseded specs; check playground daemons.
  > **Note**: skills carried no `vault`/`apply`/`protectLocalEdits` references (only pre-existing unrelated drift in the logging skill's `attachMarkdownMaterializer` example, out of scope). Playground daemons import `markdownPath` only (kept), not the vault.
- [x] **5.2** `rg` for dead references: `attachMarkdownVault`, `markdown_apply`, `protectLocalEdits`, `parseEntryBody`, `writeBody`, `ApplyPlan`. Each gone or intentional. Also fixed the workspace README export table and the sqlite path JSDoc.

### Deferred (separate PRs, explicitly not in this one)

- [ ] **D.1** `epicenter mcp` stdio adapter over `daemon.list()`/`daemon.invoke()`.
- [ ] **D.2** Frontmatter-apply action: `epicenter run <mount>.apply_frontmatter <file>` that reads ONLY frontmatter scalars (title, tags, status), validates against the row schema, and routes through the existing update action. Lossless by construction; needs none of the deleted machinery (a fresh thin action over `invokeAction`). The body stays read-only. See Open Question 4.

## Edge Cases

### Agent edits a materialized file anyway
1. Agent writes `apps/fuji/x.md` directly.
2. The edit is not routed through an action, so Yjs is unchanged.
3. Next materialize overwrites it. No corruption. (`apps/` is gitignored, so it does not even show as a tracked diff.)

### Graduating a captured item
1. User copies `apps/fuji/idea.md` into `ideas/idea.md`.
2. `ideas/` is a user zone; Epicenter never touches it.
3. App keeps reprinting its own copy under `apps/fuji/` unless the source row is soft-deleted via an action. Soft-delete already unlinks the file (see Open Question 3).

### External git pull changes an app file
1. `apps/` is gitignored, so pulls do not carry app files across machines; Yjs/the relay does.
2. Each machine materializes `apps/` from its own Yjs. No cross-machine projection conflicts.

## Open Questions (resolved)

1. **Track the projection in git?** RESOLVED: **gitignore it.** The projection is a regenerable cache; Yjs + the relay is the cross-machine sync layer, so git-tracking generated files only produces meaningless conflicts. A fresh clone runs `bun run daemon` to populate `apps/`. (Revisit if you want an offline human-readable paper backup that survives without the daemon.)

2. **Build MCP now or later?** RESOLVED: **later.** The CLI is sufficient and universal today.

3. **Archive semantics.** RESOLVED: **archive == the existing soft-delete.** `materializeTable` unlinks a file when its row goes invalid/missing, so a soft-deleted row already stops reprinting. No new "archive" concept unless you want "hidden from inbox but still valid/queryable" as a distinct state.

4. **Does any non-agent flow still need disk to Yjs import?** Verify before deleting `vault.ts`: no bulk-import/migration flow should depend on parsing markdown back into Yjs. If a one-shot bulk import is ever needed, build it as an explicit user-invoked action (`epicenter run <mount>.import`), not an automatic watcher. (The frontmatter-apply follow-up D.2 covers the common "edit metadata in the editor" case losslessly.)

## Success Criteria

- [ ] `apps/` is the only visible path Epicenter writes; `.epicenter/` holds hidden state; user zones are untouched.
- [ ] App data mutates only through actions; a coding agent can discover (`list --format json`) and invoke (`run`) without editing files.
- [ ] All three apps use `attachMarkdownExport`; `vault.ts` and the apply/push/pull subsystem are deleted; `shared.ts` keeps only the one-way path.
- [ ] `bun typecheck` and `bun test` pass; the daemon smoke test (Phase 4) passes.
- [ ] `vault/AGENTS.md` (+ `CLAUDE.md` shim) states the one rule and the CLI recipe.
- [ ] The config is a flat array of arg-free mounts (`[ fuji(), tabManager() ]`); no `projectionRoot` object, no freeform path options. `markdown_rebuild` cannot reach a user zone.

## Decisions Log

- **Layout A** (config@root + visible `apps/` + hidden `.epicenter/`). Mirrors package.json + dist + node_modules. The visible/hidden axis is "does a human read this file directly," which puts markdown in `apps/` and sqlite in `.epicenter/`.
  Revisit when: you want a pristine root (only authored files visible), which would tuck `apps/` under `.epicenter/apps/` via a config string, accepting it disappears in Obsidian/Finder.
- **Hardcoded layout, collapsed knobs.** `export default [ fuji(), tabManager() ]`; mount factories always write `apps/<mount>` + `.epicenter/sqlite/<mount>.db`. Refused BOTH a `projectionRoot` object (overclaims) AND freeform `markdownDir`/`sqliteFile` (data-loss via `markdown_rebuild`). Flexibility stays on the `attachMarkdownExport` primitive for non-vault exports. (Reversed an earlier "keep freeform + convention" draft after Codex surfaced the rebuild data-loss path.)
  Revisit when: untrusted third parties author mount configs, or multi-tenant hosting makes one mount escaping the root a real corruption risk.
- **CLI is the only shipped mutation surface** (defer MCP).
  Revisit when: an MCP-capable workflow makes native in-context discovery worth a second adapter.
- **Projection is gitignored.**
  Revisit when: materialize churn or the lack of an offline snapshot becomes a real pain.

## References

- `packages/cli/src/commands/run.ts`, `list.ts` - the agent mutation + discovery surface
- `packages/workspace/src/shared/actions.ts` (`invokeAction`) - the single validated choke point
- `packages/workspace/src/document/materializer/markdown/{export,vault,shared}.ts` - the keep / delete / simplify seam
- `packages/workspace/src/daemon/client.ts` (`daemon.list`, `daemon.invoke`) - the socket endpoints every client fronts
- `apps/fuji/src/lib/workspace/{project,entry-body-markdown}.ts` - the app to migrate + the codec to halve
- `~/Code/vault/epicenter.config.ts`, `~/Code/vault/AGENTS.md` - the vault to restructure
- Superseded: `specs/20260602T120000-*` and the two markdown-sync specs it built on

## Review

**Completed (monorepo)**: 2026-06-02
**Branch**: `worktree-bridge-cse_01APvuAW2SWJiDmYCNmGxEc2`

### What Landed

The monorepo half of the clean break: all three apps (`fuji`, `honeycrisp`, `tab-manager`) now project markdown one-way through `attachMarkdownExport`, materializing to a visible, hardcoded `apps/<mount>/` via the new `appsMarkdownPath` helper (sqlite stays at its guid-keyed `.epicenter/sqlite/` default). The entire bidirectional disk to Yjs subsystem is deleted: `vault.ts` and its `markdown_apply` reconcile, the `protectLocalEdits` dirty guard in `shared.ts`, and fuji's `parseEntryBody` import half. The freeform `markdownDir`/`sqliteFile` mount options are gone, so `markdown_rebuild` (renamed from `markdown_export_rebuild`) can never sweep a hand-authored zone. Five commits; `bun typecheck` clean across the workspace and all three apps; `bun test` 494 pass / 0 fail.

### Deviations and Discoveries

- fuji's projection is byte-identical to the old vault output; the `slugFilename`/`entryFrontmatter` in the migration sketch were illustrative and do not exist, so they were not introduced.
- Trimming `entry-body-markdown.test.ts` moved into the Phase 1 parser-removal commit (the test imported the deleted `parseEntryBody`, so the Phase 1 typecheck gate needed it gone).
- `resolveProjectPath` (in `@epicenter/workspace/node`) is now a dead export: its only callers were the removed mount path options. Left in place (a generic, still-tested pure helper, and a public-surface removal outside this spec's stated scope). Follow-up candidate.
- The vault repo imports from the sibling `../epicenter` checkout, not this worktree, which blocks Phases 3 and 4 until the code merges there.

### Follow-up Work

- Vault restructure (Phase 3) + end-to-end smoke test (Phase 4), once this PR's code is live in the sibling `../epicenter` checkout.
- Deferred per spec: `epicenter mcp` adapter (D.1) and the lossless frontmatter-apply action (D.2).
- Consider removing the now-dead `resolveProjectPath` export in a follow-up clean-break pass.
