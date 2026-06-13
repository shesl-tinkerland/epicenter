# Matter + ZenNotes Folder Protocol

**Date**: 2026-06-10
**Status**: Draft
**Owner**: Braden
**Relates to**: `20260604T120000-typed-markdown-grid-editor.md`, `20260605T214500-sqlite-projection-primitives.md`, `20260602T200000-vault-read-only-projection-agent-mutation.md`

## One Sentence

Matter should be a folder-level structured lens over Markdown files that ZenNotes continues to treat as free-form notes: Matter owns the modeled frontmatter layer, ZenNotes owns writing, navigation, rendering, and lifecycle over the same files.

## How to read this spec

```txt
Read first:
  One Sentence
  The decision in one breath
  The folder protocol
  Integration path
  Non-negotiables
  Verification

Read if changing the architecture:
  Alternatives
  Design Decisions
  Risks
  Open Questions

Long-term only:
  ZenNotes databases collapse opportunity
  Remote server adapter
```

## The decision in one breath

```txt
TARGET:
  The folder is the API.

  A Matter collection is one flat folder:
    matter.json        the model
    *.md               one row per file
    .matter/*.sqlite   derived query mirror, if enabled

  ZenNotes remains the writing vault:
    open, edit, preview, link, search, archive, trash, and render Markdown files.

  Matter remains the structured lens:
    validate frontmatter, edit fields, query rows, and classify conformance.

FIRST MOVE:
  prove side-by-side shared folder use, then add an "Open in Matter" folder action.

REFUSE FOR V1:
  merged apps
  ZenNotes embedding the Matter grid
  Matter speaking the ZenNotes server API
  runtime coupling between Electron, Tauri, Go, and Rust

ASYMMETRIC WIN:
  refuse runtime integration first, and get most of the product value through one
  on-disk contract both apps already understand.
```

## Current State

### Matter

Matter is already a typed Markdown folder editor.

```txt
folder/
  matter.json
  a.md
  b.md
  matter.sqlite
```

Current rules from `apps/matter`:

```txt
row id        = markdown file basename
columns       = YAML frontmatter keys
body          = verbatim Markdown after frontmatter
model         = matter.json fields object
watcher       = Tauri/Rust, non-recursive, top-level only
mirror        = disposable SQLite projection rebuilt from readable rows
write shape   = read fresh bytes, edit frontmatter or body, atomic write
```

Key files:

```txt
apps/matter/README.md
apps/matter/src/lib/core/parse.ts
apps/matter/src/lib/core/serialize.ts
apps/matter/src/lib/core/folder.ts
apps/matter/src/lib/vault.svelte.ts
apps/matter/src-tauri/src/watch.rs
apps/matter/src-tauri/src/mirror.rs
```

### ZenNotes

ZenNotes is already a plain-file Markdown vault app with multiple runtimes.

```txt
packages/app-core             shared React product UI
packages/bridge-contract      window.zen runtime contract
apps/desktop                  Electron shell and local filesystem bridge
apps/web                      browser bridge
apps/server                   Go server for self-hosted and remote workspaces
```

ZenNotes also has a separate CSV database feature:

```txt
<folder>/<Name>.csv
<folder>/<Name>.csv.base.json
optional linked page note per row
```

That matters because a direct Matter grid inside ZenNotes would create two structured-table models in one product. The long-term collapse opportunity is not "add Matter beside databases." It is "consider replacing CSV databases with the Matter file-as-row format."

## The folder protocol

The integration surface is not a runtime API. It is a folder shape.

```txt
modeled folder/
  matter.json
  draft-a.md
  draft-b.md
  .matter/
    matter.sqlite
```

### `matter.json`

`matter.json` is the lens manifest for one folder.

```json
{
  "fields": {
    "title": { "type": "string", "minLength": 1 },
    "status": { "type": "string", "enum": ["draft", "ready", "published"] },
    "publish_at": { "type": "string", "format": "date-time" },
    "tags": { "type": "array", "items": { "type": "string" } }
  }
}
```

Rules:

```txt
scope        one folder only
recursion    none in v1
owner        Matter writes it; ZenNotes treats it as a collection control file
absence      no matter.json means no typed lens
bad JSON     Matter degrades to raw frontmatter view
```

### Markdown files

Every immediate `*.md` file is one row.

```md
---
title: Folder protocol first
status: draft
publish_at: 2026-06-12T10:00:00Z
tags:
  - architecture
---

# Folder protocol first

The body stays normal Markdown. ZenNotes should feel completely at home here.
```

Rules:

```txt
frontmatter   structured layer
body          free-form prose layer
row id        basename
clearing      deleting a field removes the key; it does not write key: null
conflicts     files with git conflict markers are read-only in Matter
YAML          YAML 1.2 behavior; do not revive YAML 1.1 coercions
```

### Derived mirror

Matter currently writes `matter.sqlite` beside `matter.json`. That is fine for a standalone folder, but it is the wrong shared-vault default.

Target placement for ZenNotes-shared folders:

```txt
folder/
  .matter/
    matter.sqlite
```

Why:

```txt
matter.sqlite is derived, binary, frequently rewritten, and disposable.
ZenNotes already ignores dotfiles and dotfolders in watcher paths.
Git and sync tools are less likely to treat .matter/ as authored content.
The mirror stays folder-local for agents that know the protocol.
```

Non-goal:

```txt
Do not make ZenNotes understand SQLite in v1.
The mirror is for Matter and agents. ZenNotes should ignore it.
```

## Product Fit

The fit is unusually clean because the two apps care about different halves of the same file.

```txt
ZenNotes owns:
  body writing
  Markdown preview
  wikilinks
  tags in prose
  tasks
  quick capture
  archive and trash
  file navigation
  remote vault access

Matter owns:
  folder model
  frontmatter fields
  per-cell conformance
  bulk field edits
  SQL-style folder filtering
  query mirror for agents
```

The shared artifact:

```txt
one Markdown file
  frontmatter = structured record
  body        = free-form note
```

This avoids the common notes-app trap where a row and a note page are two different records that must stay linked. Here the row is the note.

## Integration Path

### Phase 0: write the protocol down and freeze fixtures

Create a small protocol fixture set inside Matter before adding integration UI.

```txt
fixtures/matter-folder/
  matter.json
  ready.md
  missing-required.md
  invalid-status.md
  prose-heavy.md
  conflict-markers.md
```

Acceptance:

```txt
[ ] parse contract covers no frontmatter, valid frontmatter, bad YAML, conflict markers.
[ ] serialize contract proves Matter preserves body bytes when editing a field.
[ ] serialize contract documents value-identity frontmatter rewrite.
[ ] clearing a field deletes the key and never writes key: null.
[ ] .matter/matter.sqlite is treated as derived and ignored by Matter's row watcher.
```

### Phase 1: side-by-side shared folder

Prove the simplest product story with no runtime coupling.

```txt
User flow:
  1. User opens a ZenNotes vault.
  2. User creates or selects a folder with matter.json.
  3. User opens that folder in Matter.
  4. ZenNotes edits body text.
  5. Matter edits frontmatter fields.
  6. Both apps observe file changes as external writes.
```

Acceptance:

```txt
[ ] Matter can open a folder inside a ZenNotes vault.
[ ] Matter field edit appears in ZenNotes after the watcher settles.
[ ] ZenNotes body edit appears in Matter after the watcher settles.
[ ] Matter does not show .matter/matter.sqlite as a row.
[ ] ZenNotes does not show matter.json or .matter/matter.sqlite as normal notes.
[ ] Moving a file to ZenNotes archive or trash removes it from Matter's current folder view.
```

### Phase 2: folder-level launch bridge

Once Phase 1 is proven, make the workflow discoverable.

```txt
ZenNotes folder context menu:
  Open in Matter

Implementation choices:
  matter://open?path=<encoded absolute folder path>
  or
  matter open <absolute folder path>
```

Decision:

```txt
Prefer a CLI first if Matter already needs command-line automation.
Prefer a deep link first if Tauri packaging makes protocol handling cheap.
Do not make ZenNotes import Matter code.
The bridge passes only a folder path.
```

Acceptance:

```txt
[ ] The action appears only for local folders, not remote workspaces.
[ ] The action passes a folder path, never a note path or whole vault.
[ ] Matter opens the folder and starts its normal race-free watch.
[ ] If Matter is not installed, ZenNotes shows one actionable install/open message.
```

### Phase 3: extract the pure protocol core only after two consumers exist

Matter's pure core is already mostly framework-free:

```txt
parse.ts
serialize.ts
folder.ts
model.ts
conformance.ts
```

But extraction should wait until there is a real second consumer.

Candidate package:

```txt
packages/matter-protocol/
  parse markdown entry
  serialize frontmatter/body
  parse matter.json
  classify rows
  provide fixtures
```

Refusal:

```txt
Do not extract FolderGrid or Svelte components just to feel integrated.
The protocol earns a package before the UI does.
```

### Phase 4: remote adapter, only if the server grows the right primitives

Matter speaking the ZenNotes server API is attractive, but not a v1 move.

Current mismatch:

```txt
Matter needs:
  armed watcher then seed
  folder-scoped model file access
  read fresh bytes then write atomically
  per-file write serialization
  .json sidecar read/write

ZenNotes server currently offers:
  list notes
  read note
  write whole note
  watch vault changes
  asset read and upload paths
```

This is close enough to imagine and far enough to defer.

Remote adapter prerequisite:

```txt
ZenNotes server exposes a folder collection API:
  list modeled folder entries
  read/write matter.json
  read/write markdown entry with compare or version guard
  watch with seed or explicit snapshot version
```

Until then, remote Matter can accidentally lose the race-free property that makes local Matter valuable.

### Phase 5: collapse ZenNotes databases, if the format proves itself

ZenNotes databases are CSV plus sidecar plus optional page notes. Matter's format collapses that into one file per row.

```txt
ZenNotes database today:
  Database.csv
  Database.csv.base.json
  Pages/Some Record.md

Matter-shaped collection:
  matter.json
  Some Record.md
```

This is not a v1 integration task. It is the long-term asymmetric win.

Question for later:

```txt
Should ZenNotes databases become Matter folders?
```

If yes, ZenNotes gets one structured data model instead of two.

## Alternatives

| Option | Keep | Cost | Decision |
| --- | --- | --- | --- |
| Side-by-side shared folder | Most value with no runtime coupling | Needs file protocol discipline | Do first |
| "Open in Matter" folder action | Makes the side-by-side flow feel native | Packaging and install detection | Do second |
| Extract pure Matter protocol core | Prevents parser drift once two apps consume it | Published API too early if done now | Defer until second consumer |
| Embed Matter grid in ZenNotes | One app surface | React/Svelte split, local SQLite mismatch, duplicate database feature | Refuse for v1 |
| Matter speaks ZenNotes server API | Remote workspaces | Rebuilds Matter's strongest watch/write guarantees over weaker primitives | Defer |
| Merge apps | One brand | Rewrite-level complexity, runtime stack collision, product thesis blur | Refuse |

## Design Decisions

| Decision | Class | Choice | Rationale |
| --- | --- | --- | --- |
| Integration unit | 1 evidence | folder, not vault | Matter is flat and non-recursive; ZenNotes vaults are nested with lifecycle areas. |
| Primary contract | 2 coherence | on-disk folder protocol | Both apps already tolerate external writers over plain files. |
| Runtime coupling | 2 coherence | none in v1 | The product sentence works without Electron/Tauri/Go/Rust coupling. |
| Launch bridge | 3 taste | pass folder path only | Smallest UX affordance; avoids shared code. |
| Mirror placement | 2 coherence | `.matter/matter.sqlite` for shared folders | Derived binary state should not appear as note or asset content. |
| Frontmatter identity | 2 coherence | value-identity, not byte-identity, unless explicitly changed | Matter's cell editor owns columns. Exact YAML formatting and comments cannot also be sacred without a different emitter. |
| Remote adapter | Deferred | no v1 server adapter | Needs seeded watch and model-file write primitives first. |
| ZenNotes database collapse | Deferred | consider replacing CSV databases later | Matter's file-as-row model may delete a two-source-of-truth feature, but only after side-by-side use proves the product. |

## Non-negotiables

### 1. The folder is the API

Each app must remain correct when the other is treated as an arbitrary external writer.

```txt
Allowed:
  ZenNotes adds "Open in Matter."
  Matter opens a ZenNotes folder path.
  A future shared package parses the folder protocol.

Not allowed:
  Matter imports ZenNotes app code.
  ZenNotes imports Matter app code for v1.
  Either app needs the other process to be running.
```

### 2. Frontmatter formatting is an explicit contract

Matter currently re-emits frontmatter canonically. That preserves values and body text, not comments or exact YAML formatting.

This must be stated in product terms:

```txt
In a modeled Matter folder, frontmatter is the structured column layer.
Matter may rewrite it canonically when a field is edited.
Put explanatory prose and comments in the Markdown body.
```

Alternative:

```txt
Require comment-preserving YAML writes before sharing folders with ZenNotes.
```

The spec chooses the first path for v1 because it is simpler and honest. If that feels too destructive in real writing vaults, stop before Phase 2 and change Matter's emitter.

### 3. Matter sidecars are not notes

ZenNotes should not show these as normal content:

```txt
matter.json
.matter/
.matter/matter.sqlite
```

`matter.json` can be visible as a folder control affordance later. It should not be a note, asset, or search result by default.

### 4. Write conflicts are not secretly solved

Matter protects its own same-file writes and reads fresh bytes before editing one field. That does not make simultaneous cross-app editing conflict-free.

```txt
Safe expectation:
  human-speed edits usually converge through file watchers.

Unsafe promise:
  concurrent edits to the same open file are merged perfectly.
```

Before launch, test a dirty ZenNotes editor buffer plus a Matter field edit. If ZenNotes can clobber the fresh field edit on save, the product needs either a warning, reload guard, or body-only save path for Matter folders.

## Architecture

### Side-by-side local flow

```txt
Matter
  watch_folder(path)
    -> arm native watcher
    -> scan matter.json + top-level *.md
    -> classify rows
    -> edit frontmatter by read-modify-write

ZenNotes
  watches vault root
    -> sees Markdown file change
    -> refreshes note metadata/content
    -> keeps normal writing workflow
```

### Launch bridge

```txt
ZenNotes folder menu
  -> open external URL or CLI command
    -> Matter receives absolute folder path
      -> Matter opens normal local vault
```

No shared runtime. No shared network session. No shared database.

### Future remote adapter

```txt
Matter remote backend
  -> ZenNotes server folder collection API
    -> seeded folder snapshot
    -> watch stream with version
    -> read/write matter.json
    -> read/write markdown entry with conflict guard
```

This is a new server contract, not a thin wrapper over current whole-note APIs.

## Implementation Plan

### Phase 0: protocol and fixtures

```txt
[ ] Move mirror target from `matter.sqlite` to `.matter/matter.sqlite`, or add a mode that does so for shared folders.
[ ] Add protocol fixtures for modeled folders.
[ ] Add tests for field edit preserving body bytes.
[ ] Add tests documenting frontmatter canonicalization.
[ ] Add tests that `.matter/` contents never become rows.
[ ] Add a short `docs/matter-folder-protocol.md` or README section.
```

### Phase 1: shared folder proof

```txt
[ ] Create a sample modeled folder inside a ZenNotes vault.
[ ] Open it in Matter.
[ ] Open the same folder in ZenNotes.
[ ] Edit body in ZenNotes, observe Matter update.
[ ] Edit field in Matter, observe ZenNotes update.
[ ] Verify no sidecar noise in ZenNotes note list, asset list, watcher UI, or git status beyond expected Markdown changes.
[ ] Verify archive/trash moves are row removals in Matter.
```

### Phase 2: launch bridge

```txt
[ ] Add Matter open-by-path entrypoint.
[ ] Add ZenNotes folder-level "Open in Matter" affordance.
[ ] Gate to local folders only.
[ ] Add install-missing behavior.
[ ] Add a manual smoke test across macOS first, then Windows/Linux if packaging supports it.
```

### Phase 3: extract only if earned

```txt
[ ] Count real consumers of the protocol parser.
[ ] If ZenNotes or another app consumes it, extract pure core to a package.
[ ] Keep UI components in Matter until a second UI consumer exists.
[ ] Keep Tauri/Rust watcher in Matter until another runtime needs the exact primitive.
```

### Phase 4: server adapter, if still wanted

```txt
[ ] Specify ZenNotes folder collection API.
[ ] Add seeded watch or snapshot-version handshake.
[ ] Add matter.json read/write.
[ ] Add conflict guard for entry writes.
[ ] Implement Matter backend abstraction only after API exists.
```

## Verification

### Local protocol tests

```txt
bun test apps/matter/src/lib/core/parse.test.ts
bun test apps/matter/src/lib/core/serialize.test.ts
bun test apps/matter/src/lib/core/folder.test.ts
```

Add tests for:

```txt
[ ] `matter.json` missing -> raw view.
[ ] junk `matter.json` -> raw view with diagnostic.
[ ] field edit preserves body exactly.
[ ] body edit preserves frontmatter values.
[ ] conflict markers produce unreadable/read-only file.
[ ] `.matter/matter.sqlite` is ignored by row watcher.
```

### Cross-app smoke test

```txt
Given:
  a ZenNotes local vault
  a modeled folder inside it
  Matter opened on that folder

Prove:
  body edit in ZenNotes reaches Matter
  field edit in Matter reaches ZenNotes
  Matter mirror writes do not show as notes or assets
  moving a file out of the folder removes the Matter row
  dirty-buffer conflict behavior is understood and acceptable
```

### Remote non-goal test

```txt
Do not claim remote workspace support until Matter can open a ZenNotes server
folder with seeded watch, model-file access, and write conflict guards.
```

## Risks

### Frontmatter comments and formatting

Matter's current writer is value-preserving, not byte-preserving. A user who hand-authors frontmatter comments may perceive canonical rewrite as data loss.

Mitigation:

```txt
Make the contract visible.
If that is not acceptable, switch to a comment-preserving YAML Document writer before integration UI.
```

### Same-file concurrent edits

Matter's fresh read-modify-write protects against stale field writes inside Matter. It does not guarantee perfect merge with a dirty ZenNotes editor buffer.

Mitigation:

```txt
Test and document the behavior before shipping Phase 2.
Prefer reload/conflict prompts over silent overwrite.
```

### Sidecar churn

A visible `matter.sqlite` rewritten per batch can create watcher churn, sync churn, and noisy git status.

Mitigation:

```txt
Move it under `.matter/`.
Teach ZenNotes to ignore `.matter/`.
Document it as disposable derived state.
```

### License boundary

Matter is AGPL-3.0-or-later. ZenNotes is MIT.

Mitigation:

```txt
Prefer protocol integration and launch bridge.
Do not copy Matter code into ZenNotes without an explicit license decision.
If code sharing is desired, decide whether the shared package is acceptable for both projects.
```

### Duplicate structured data models

ZenNotes already has CSV databases. Adding a Matter grid inside ZenNotes without resolving that product overlap creates two ways to do the same job.

Mitigation:

```txt
Treat Matter format as a possible replacement path for ZenNotes databases, not a second table product.
Defer UI embedding until that migration story exists.
```

## Open Questions

1. Should Matter always move its mirror to `.matter/matter.sqlite`, or only when opening a folder inside a ZenNotes vault?
2. Should `matter.json` be shown in ZenNotes as a folder badge or hidden entirely?
3. Does ZenNotes currently protect dirty editor buffers from external frontmatter edits?
4. Should Matter use a CLI, deep link, or both for open-by-path?
5. Would ZenNotes accept Matter's value-identity frontmatter rule, or should shared folders require comment-preserving YAML writes?
6. Is the long-term target to replace ZenNotes CSV databases with Matter folders?
7. If a future server adapter exists, is it owned by Matter, ZenNotes, or a shared protocol package?

## Decision Log

- Refuse merged app: the product sentence works through files; merging Tauri/Svelte/Rust and Electron/React/Go creates a rewrite-sized problem.
- Refuse Matter remote adapter for v1: current ZenNotes APIs do not provide the seeded folder watch and model-file write surface Matter needs.
- Refuse grid extraction for v1: the pure protocol may earn a package, but the UI does not have a second consumer yet.
- Keep frontmatter value-identity for v1: it matches Matter's column ownership. Revisit if writers actually keep meaningful comments in frontmatter.
- Move derived mirror out of the visible folder root: the query mirror is machine state and should not become ZenNotes content.

## References

- `apps/matter/README.md`
- `apps/matter/src/lib/core/parse.ts`
- `apps/matter/src/lib/core/serialize.ts`
- `apps/matter/src/lib/core/folder.ts`
- `apps/matter/src/lib/vault.svelte.ts`
- `apps/matter/src-tauri/src/watch.rs`
- `apps/matter/src-tauri/src/mirror.rs`
- ZenNotes: `docs/explanation/how-zennotes-works.md`
- ZenNotes: `docs/reference/vault-and-folder-model.md`
- ZenNotes: `packages/bridge-contract/src/bridge.ts`
- ZenNotes: `packages/shared-domain/src/databases.ts`
