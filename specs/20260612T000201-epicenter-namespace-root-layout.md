# Epicenter Folder Layout

**Date**: 2026-06-12
**Status**: Accepted
**Owner**: Braden
**Supersedes (in part)**: `20260522T220000-workspace-project-layout.md`, `20260602T200000-vault-read-only-projection-agent-mutation.md`

## One Sentence

`epicenter.config.ts` marks your Epicenter folder (the Epicenter root) whose direct child folders are mount projections and whose `.epicenter/` sibling holds machine state for that root.

## How to read this spec

```txt
Read first:
  One Sentence
  Target Shape
  Vocabulary
  Invariants
  Implementation Plan

Read if changing code:
  Current State
  Architecture
  Call Sites
  Edge Cases

Decision context:
  Design Decisions
  Rejected Alternatives
  Open Questions
```

## Overview

This spec changes the meaning of `projectDir`. It should no longer mean "the repository root by default." It should mean "the folder whose local namespace Epicenter owns."

That lets mount markdown live at:

```txt
projectDir/<mountName>
```

without per-mount sentinel files. The config file marks the namespace boundary, and the direct children under that boundary are generated mount projections.

## Target Shape

The folder that holds `epicenter.config.ts` is your Epicenter folder (the
Epicenter root). Its name is the user's choice; nothing reserves the name
`apps`. A typical layout uses a neutral container name:

```txt
repo/                         unreserved repo root
+-- docs/
+-- packages/
+-- notes/
`-- epicenter/                Epicenter root (folder name is the user's choice)
    +-- epicenter.config.ts   tracked, declares mounts
    +-- .epicenter/           ignored, machine state for this root
    +-- fuji/                 ignored, generated Fuji projection
    `-- honeycrisp/           ignored, generated Honeycrisp projection
```

The same model works under any other container name, including `apps/` when a
user wants a visible `apps/` surface:

```txt
repo/
`-- apps/
    +-- epicenter.config.ts
    +-- .epicenter/
    +-- fuji/
    `-- honeycrisp/
```

The folder name is not the marker. `epicenter.config.ts` is the marker. The folder name is only the user's chosen Epicenter root.

## Vocabulary

```txt
repo root
  A normal repository or folder. Epicenter does not reserve its direct children.

Epicenter root (your Epicenter folder)
  The folder that holds epicenter.config.ts. Code calls this epicenterRoot.
  Epicenter owns the direct child folders for declared mounts. The folder name
  is the user's choice; nothing reserves the name apps.

mount folder
  epicenterRoot/<mountName>. Generated markdown projection for one mount.

machine state
  epicenterRoot/.epicenter. Hidden local state such as yjs logs, sqlite mirrors,
  logs, metadata, and trash.
```

In code, the value is the `epicenterRoot` parameter, and docs and comments define it as the Epicenter root (the folder that holds `epicenter.config.ts`).

## Motivation

### Current State

Current path helpers treat `projectDir` as the folder containing `epicenter.config.ts`, but the visible markdown helper adds its own `apps/` child:

```ts
// packages/workspace/src/document/workspace-paths.ts
export function appsMarkdownPath(
	projectDir: string,
	mountName: string,
): string {
	return join(projectDir, 'apps', mountName);
}
```

That made this shape natural:

```txt
repo/
+-- epicenter.config.ts
+-- .epicenter/
`-- apps/
    `-- fuji/
```

It also made `apps/` act as a crude safety fence around `markdown_rebuild`:

```ts
// packages/workspace/src/document/materializer/markdown/export.ts
const files = await readdir(directory, { recursive: true });
for (const filename of files) {
	if (!filename.endsWith('.md')) continue;
	const path = join(directory, filename);
	await unlink(path);
}
```

This creates problems:

1. **`projectDir` overclaims normal repos**: if `epicenter.config.ts` lives at the repo root, then a future `projectDir/<mountName>` layout makes ordinary repo folders look like possible Epicenter mount folders.
2. **`appsMarkdownPath` hides the real boundary**: the namespace boundary is not actually `projectDir`; it is `projectDir/apps`.
3. **Per-mount sentinels compensate for a fuzzy root**: `.epicenter-export.json` or `.epicenter-mount` becomes necessary only when a mount folder might also be a user folder.
4. **`daemon up` can provision the wrong boundary**: today `epicenter daemon up -C repo` may create `repo/epicenter.config.ts` if discovery fails, which overclaims the repo root in the new model.

### Desired State

The folder containing `epicenter.config.ts` is the Epicenter namespace. Visible markdown projections are direct children:

```txt
namespaceRoot/
+-- epicenter.config.ts
+-- .epicenter/
+-- fuji/
`-- honeycrisp/
```

If a user wants those visible mount folders to appear under `repo/apps`, they put the config at `repo/apps/epicenter.config.ts`.

## Invariants

These are the rules future implementation should preserve.

```txt
1. Config marks the namespace.
   The parent folder of epicenter.config.ts is the Epicenter namespace root.

2. Repo roots stay unreserved.
   A normal repo can contain docs/, packages/, notes/, src/, or anything else.
   Epicenter does not reserve those names unless the repo root itself contains
   epicenter.config.ts.

3. Mount folders are direct children.
   For each declared mount named <mountName>, the visible projection lives at
   namespaceRoot/<mountName>.

4. Hidden state is a namespace sibling.
   namespaceRoot/.epicenter belongs to the whole namespace, not to any one
   mount folder.

5. No user-authored content inside the namespace root.
   User-owned folders live outside the namespace root. Inside the namespace,
   direct child folders are either declared mount folders or reserved
   Epicenter folders.

6. Mount names are path segments.
   A mount name must not contain slash, backslash, dot-dot, path separators,
   control characters, or reserved names such as .epicenter and
   epicenter.config.ts.

7. Rendered paths cannot escape.
   Table dirs and row filenames produced by attachMarkdownExport must resolve
   under the mount projection directory before any write or delete runs.

8. No per-mount sentinel in the namespace model.
   The namespace root is the claim. A per-mount sentinel is only needed if
   generated and user-owned folders can cohabit the same parent.

9. Rebuild may be broad only inside a declared mount projection.
   markdown_rebuild may sweep generated markdown under mount folders because
   the namespace owns those folders. It must never sweep outside the namespace
   or through path-escaped filenames.
```

The shortest version:

```txt
If projectDir is a dedicated Epicenter namespace root, the config file is enough.
If projectDir is a normal repo or notes folder, each mount needs its own claim artifact.
This spec chooses the namespace root.
```

## Architecture

### Before

```txt
repo/                         projectDir
+-- epicenter.config.ts
+-- .epicenter/
`-- apps/
    +-- fuji/
    `-- honeycrisp/
```

`projectDir` is the config folder, but visible projections live one level deeper.

### After

```txt
repo/                         not an Epicenter namespace
`-- apps/                     projectDir, the Epicenter namespace root
    +-- epicenter.config.ts
    +-- .epicenter/
    +-- fuji/
    `-- honeycrisp/
```

`projectDir` is now the folder Epicenter owns. Visible projections are direct children.

### State ownership

```txt
namespaceRoot/epicenter.config.ts
  user-authored config, tracked

namespaceRoot/.epicenter/
  daemon-owned machine state, ignored

namespaceRoot/<mountName>/
  daemon-owned visible projection, ignored

repo root and siblings of namespaceRoot
  user or repo-owned, outside Epicenter's local namespace
```

## Design Decisions

| Decision | Class | Choice | Rationale |
| --- | --- | --- | --- |
| Namespace marker | 2 coherence | `epicenter.config.ts` marks the namespace root | The config file already drives discovery and mount composition. Using its parent as the boundary removes per-mount sentinels. |
| Visible projection path | 2 coherence | `namespaceRoot/<mountName>` | Direct child folders are only safe once `namespaceRoot` is dedicated to Epicenter. |
| Hidden state path | 2 coherence | `namespaceRoot/.epicenter/` | State belongs to the namespace, not to a mount projection folder. |
| Per-mount sentinel | 2 coherence | Reject | The sentinel solves mixed ownership. This design refuses mixed ownership at the namespace boundary. |
| Per-file manifest | 2 coherence | Reject | A manifest solves union folders. This design makes mount folders exclusive generated output. |
| `apps/` name | 3 taste | Use as docs default for vault-style projects | It preserves the current visible path when config moves from `repo/` to `repo/apps/`. Revisit if `apps/` conflicts with source package directories. |
| Project discovery from repo root | 3 taste | Keep upward-only discovery for commands, document `-C apps` | Scan-down adds ambiguity when a repo has multiple namespace roots. Revisit if the `-C` requirement becomes a daily paper cut. |
| `projectDir` name in code | 3 taste | Keep for first implementation wave, redefine in docs | A full rename to `namespaceDir` is cleaner but wide. Revisit if the term keeps causing wrong config placement. |

## Call Sites: Before and After

### Path helper

Before:

```ts
const mdDir = appsMarkdownPath(projectDir, mount);
// projectDir/apps/<mount>
```

After:

```ts
const mdDir = mountMarkdownPath(projectDir, mount);
// projectDir/<mount>
```

Recommendation: add `mountMarkdownPath(projectDir, mountName)` and migrate first-party app factories to it. Keep `appsMarkdownPath` only as a temporary compatibility alias if removing it would force unrelated playground churn.

### Vault layout

Before:

```txt
vault/
+-- epicenter.config.ts
+-- .epicenter/
`-- apps/
    `-- fuji/
```

After:

```txt
vault/
`-- apps/
    +-- epicenter.config.ts
    +-- .epicenter/
    `-- fuji/
```

The visible Fuji path stays `vault/apps/fuji`. The meaning of `projectDir` changes from `vault` to `vault/apps`.

### CLI

Before:

```sh
epicenter daemon up -C vault
epicenter list -C vault
epicenter run -C vault fuji.entries_update '{}'
```

After:

```sh
epicenter daemon up -C vault/apps
epicenter list -C vault/apps
epicenter run -C vault/apps fuji.entries_update '{}'
```

Running inside `vault/apps/fuji` still works because `findProjectRoot()` walks up to `vault/apps/epicenter.config.ts`.

## Implementation Plan

### Phase 1: Name the namespace boundary

- [ ] **1.1** Update docs and JSDoc so `projectDir` means "Epicenter namespace root," not "repo root."
- [ ] **1.2** Add `mountMarkdownPath(projectDir, mountName)` returning `join(projectDir, mountName)`.
- [ ] **1.3** Add tests for `mountMarkdownPath` and reserved mount names.
- [ ] **1.4** Decide whether `appsMarkdownPath` is deleted immediately or kept as a deprecated alias for one release.

### Phase 2: Move first-party vault mounts to direct children

- [ ] **2.1** Change Fuji, Honeycrisp, and Tab Manager project factories to materialize markdown with `mountMarkdownPath(projectDir, mount)`.
- [ ] **2.2** Keep yjs and sqlite under `projectDir/.epicenter/` using existing guid-keyed helpers.
- [ ] **2.3** Update comments in first-party mount factories that still describe `appsMarkdownPath`.
- [ ] **2.4** Run focused tests for workspace paths and each changed app package.

### Phase 3: Make markdown export confinement true

- [ ] **3.1** Validate table `dir` values before joining them onto the export root.
- [ ] **3.2** Validate rendered row filenames before writing or unlinking.
- [ ] **3.3** Use resolved absolute paths and reject any path that escapes the intended export root.
- [ ] **3.4** Update `tryUnlink`, `writeMarkdownFile`, and rebuild code to use the same confinement helper.
- [ ] **3.5** Add regression tests for `../escape.md`, absolute filenames, nested valid filenames, and case-insensitive collision behavior where feasible.

### Phase 4: Rebuild semantics under the namespace model

- [ ] **4.1** Keep `markdown_rebuild` as a projection rebuild action.
- [ ] **4.2** Update its description to stop saying "Destructive" without context.
- [ ] **4.3** Move deleted files to `projectDir/.epicenter/trash/<mount>/<timestamp>/` where the caller has enough context to provide `projectDir` and mount name.
- [ ] **4.4** If the generic primitive cannot know `projectDir` and mount name, keep hard unlink in the primitive but wrap first-party mount rebuilds with trash semantics at the mount-factory layer.
- [ ] **4.5** Add tests proving rebuild cannot delete outside the mount projection even when table dirs or filenames are malicious.

### Phase 5: CLI and provisioning

- [ ] **5.1** Change command descriptions from "Project root" to "Epicenter namespace root."
- [ ] **5.2** Keep `findProjectRoot()` upward-only for command execution.
- [ ] **5.3** Change `daemon up` provisioning so a missing config is not accidentally created at a normal repo root. Prefer an explicit init flow or require `-C <namespace-dir>`.
- [ ] **5.4** Add docs showing `epicenter daemon up -C apps` from a repo root.
- [ ] **5.5** Add or update tests for provisioning, discovery, and error messages.

### Phase 6: Vault migration

- [ ] **6.1** Move `vault/epicenter.config.ts` to `vault/apps/epicenter.config.ts`.
- [ ] **6.2** Move `vault/.epicenter/` to `vault/apps/.epicenter/` so yjs and sqlite state follow the namespace root.
- [ ] **6.3** Keep visible projections at `vault/apps/<mount>`.
- [ ] **6.4** Update `.gitignore` so config is tracked but generated mount folders and `.epicenter/` are ignored.
- [ ] **6.5** Update root `AGENTS.md` and `CLAUDE.md` shim to say `apps/` is the Epicenter namespace root.
- [ ] **6.6** Start the daemon with `-C vault/apps` and prove actions mutate projections.

### Phase 7: Documentation sweep

- [ ] **7.1** Update `docs/scripting.md`.
- [ ] **7.2** Update `packages/cli/README.md`.
- [ ] **7.3** Update `packages/workspace/README.md`.
- [ ] **7.4** Mark older path specs as superseded where they teach repo-root config or `projectDir/apps/<mount>`.
- [ ] **7.5** Search for `appsMarkdownPath`, `Project root`, `project root`, and `projectDir/apps`.

## Gitignore Model

The Epicenter namespace root owns its own `.gitignore`. For a namespace at
`repo/apps/`, the file lives at `repo/apps/.gitignore`:

```gitignore
# Epicenter folder. Only epicenter.config.ts is tracked; the generated mount
# projections and the machine state under .epicenter/ are derived from the Yjs
# log and rebuilt on demand, so git ignores them.
/*
!/.gitignore
!/epicenter.config.ts
```

If the namespace needs a tracked `AGENTS.md` or README:

```gitignore
!/AGENTS.md
!/README.md
```

Do not ignore the namespace without unignoring the config. The config is the
tracked boundary marker. `openProject()` claims the namespace after config,
auth, mount-name, and populated-folder validation, but before any mount opens.
Fresh claims write the root ignore before creating `.epicenter/`, so
`.epicenter/` remains the "already claimed" marker.

## Edge Cases

### User runs from repo root

1. User has `repo/apps/epicenter.config.ts`.
2. User runs `epicenter list` from `repo/`.
3. `findProjectRoot()` does not scan down.
4. Command should fail with a clear message: run from `repo/apps`, pass `-C apps`, or initialize a namespace.

This is deliberate for v1. A scan-down fallback can be added later only if ambiguity rules are clear.

### Repo already has an `apps/` source directory

1. Repo uses `apps/` for source packages.
2. Epicenter namespace should not be placed there unless that folder is dedicated to projections.
3. Use `epicenter/` or another namespace folder instead.

The marker is `epicenter.config.ts`, not the literal folder name `apps`.

### Existing non-empty mount folder on first startup

1. User creates `repo/apps/epicenter.config.ts`.
2. `repo/apps/fuji/` already has files.
3. Under the namespace model, direct child folders are generated mount folders.

Recommendation: first implementation should refuse this on bootstrap if `.epicenter/` does not exist yet, because the namespace has not been established. Once `.epicenter/` exists, rebuild may treat declared mount folders as generated projection folders.

### Mount startup partially fails

1. User creates `repo/apps/epicenter.config.ts` with multiple mounts.
2. The populated-folder guard passes.
3. `openProject()` writes `repo/apps/.gitignore`, then creates `repo/apps/.epicenter/`.
4. One mount later fails while opening.

Recommendation: keep the namespace claim. The folder has already passed the
ownership guard, so startup failure should release runtime resources but should
not roll back the git boundary. This preserves the invariant that `.epicenter/`
exists only after the root ignore has been handled.

After this point, declared mount folders are reserved even if no projection was
generated before the startup failure. The bootstrap guard protects files that
predate the namespace claim; it does not make post-claim mount folders a safe
place for hand-authored content.

### Mount removed from config

1. `fuji()` is removed from `epicenter.config.ts`.
2. `apps/fuji/` remains on disk.
3. Daemon should not delete it automatically during startup.

Recommendation: leave the folder and surface it in a future `epicenter check` as an orphaned projection folder.

### Mount renamed

1. Mount name changes from `fuji` to `journal`.
2. Projection path changes from `namespaceRoot/fuji` to `namespaceRoot/journal`.
3. Old folder remains unless a migration moves or deletes it.

Recommendation: do not auto-detect renames. Treat this as remove plus add. A future check command can suggest cleanup.

### Rendered filename escapes the mount folder

1. A row renderer returns `../../notes/x.md`.
2. The exporter resolves the target path.
3. The exporter rejects the row before writing or deleting.

This guard belongs in `attachMarkdownExport`, not in first-party app code.

## Rejected Alternatives

### Keep `epicenter.config.ts` at the repo root

Rejected for the mount-as-direct-child model. It makes every direct child of the repo look like potential generated output.

### Add `.epicenter-export.json` inside each mount

Rejected for the namespace model. A per-mount sentinel is useful only when mount folders can be mixed with user folders under the same parent. This spec refuses that mixture.

### Keep a per-file generated manifest

Rejected. A manifest solves file-level cohabitation. The cleaner rule is directory-level ownership: a mount folder is generated output.

### Add scan-down discovery immediately

Rejected for v1. A repo may contain several namespace roots. Upward-only discovery is predictable and safe. Revisit if daily use shows `-C apps` is too awkward.

### Store `.epicenter/` inside each mount folder

Rejected. `.epicenter/` is namespace state, not projection content. Putting it inside each mount makes every mount look like a separate project root and blurs the boundary.

### Round-trip editing of the projection (markdown as source)

Rejected. The markdown folder is a read-only projection of the Yjs log, not a source. Making file edits flow back means reconstructing CRDT structure from a lossy, flattened view, and that reverse map is not generally invertible (fuji reads the body from a separate content-doc, so the `.md` on disk does not even hold everything needed to rebuild the row).

A continuous watcher fights editor atomic-save patterns, partial writes, multiple events per save, and the feedback loop where a re-projection write looks like a user edit. An explicit "re-upload the folder" action avoids the watcher but clobbers concurrent edits from other devices, throwing away the merge guarantee that is the entire reason for a CRDT.

The single write path is the app or the CLI. If editor ergonomics matter later, an `epicenter edit` checkout that commits through a workspace action gives "edit in my editor" without a watcher and without clobbering, because the save is a normal merging write. The on-disk projection stays read-only output.

## Open Questions

1. **Should the default namespace folder be `apps/` or `epicenter/` in new docs?**
   - Recommendation: use `apps/` for vault-style projects because it preserves the current visible paths. Mention `epicenter/` as the escape hatch when `apps/` is already source-code territory.

2. **Should `projectDir` be renamed to `namespaceDir` in public APIs?**
   - Recommendation: defer the rename. First make the semantics true, then decide whether the name still misleads.

3. **Should `daemon up` create a namespace folder automatically?**
   - Recommendation: avoid implicit repo-root creation. Prefer an explicit init flow that writes `apps/epicenter.config.ts` or accepts the target namespace path.

4. **Should rebuild always trash before deleting?**
   - Refused. With directory-level ownership (a mount folder is generated output) and the bootstrap guard refusing a pre-populated mount folder before `.epicenter/` exists, the only files a rebuild sweeps are ones Epicenter generated, and those re-project from the Yjs log. So the delete is not data loss and a trash protects nothing. Trash was a proxy for "the user edited a projected file"; that case is refused outright (see Rejected Alternatives: round-trip editing), so the proxy is unnecessary and would add an unbounded trash plus per-mount plumbing.
   - Revisit when: rebuild starts sweeping files Epicenter did not generate, or the projection becomes editable source (which this spec refuses).

5. **Should projected files be written read-only (mode `0444`)?**
   - Recommendation: lean yes, as honest enforcement of the read-only contract. An accidental editor save then fails loudly instead of being silently discarded on the next rebuild, which is the real UX trap. Cost: some tools and some users hit "why can't I edit this," so it needs a clear message and the `epicenter edit` escape hatch. Defer until the edit path exists if that friction outweighs the safety.

## Success Criteria

- [ ] `projectDir` is documented as the Epicenter namespace root.
- [ ] First-party visible markdown projections live at `projectDir/<mountName>`.
- [ ] The default vault layout keeps visible paths as `vault/apps/<mountName>` by moving the config to `vault/apps/epicenter.config.ts`.
- [ ] `.epicenter/` lives next to `epicenter.config.ts`.
- [ ] No per-mount sentinel or per-file manifest is introduced for the namespace-root model.
- [ ] `attachMarkdownExport` rejects table dirs and filenames that escape the export root.
- [ ] `markdown_rebuild` cannot delete outside a declared mount projection.
- [ ] CLI docs tell users to run from the namespace root or pass `-C <namespace-root>`.
- [ ] Tests cover path helpers, discovery behavior, path confinement, and rebuild safety.

## References

- `packages/workspace/src/document/workspace-paths.ts` - current `appsMarkdownPath`, `markdownPath`, `sqlitePath`, and `yjsPath` helpers.
- `packages/workspace/src/document/materializer/markdown/export.ts` - current markdown exporter, path joins, and rebuild sweep.
- `packages/workspace/src/client/find-project-root.ts` - upward-only config discovery.
- `packages/cli/src/commands/up.ts` - current provisioning writes `epicenter.config.ts` and `.epicenter/`.
- `packages/cli/src/util/common-options.ts` - CLI `-C` language currently says project root.
- `apps/fuji/src/lib/workspace/project.ts` - first-party mount factory using `appsMarkdownPath`.
- `apps/honeycrisp/project.ts` - first-party mount factory using `appsMarkdownPath`.
- `apps/tab-manager/project.ts` - first-party mount factory using `appsMarkdownPath`.
- `specs/20260602T200000-vault-read-only-projection-agent-mutation.md` - previous visible `apps/` projection model.
- `specs/20260522T220000-workspace-project-layout.md` - older project-root layout model.

## Decisions Log

- Keep the code term `projectDir` for the first wave: this avoids a broad public rename while the layout changes.
  Revisit when: docs still need to repeatedly explain that `projectDir` is not the repo root.

- Keep upward-only discovery for command execution: it is predictable and avoids choosing between several child namespace roots.
  Revisit when: users routinely run commands from repo roots that contain exactly one Epicenter namespace.

- The markdown projection is read-only; round-trip editing is refused. Writes enter through the app or the CLI, and the projection regenerates from Yjs. The bootstrap guard (refuse a pre-populated mount folder before `.epicenter/` exists) is the directory-level ownership check; no per-mount marker is added.
  Revisit when: there is a concrete product need to treat on-disk markdown as editable source, with a defined merge story against concurrent CRDT edits.

- Rebuild hard-deletes generated projection files; no trash. Directory-level ownership plus the bootstrap guard mean a sweep only ever removes Epicenter-generated, regenerable output.
  Revisit when: rebuild's sweep scope widens beyond Epicenter-generated files.
