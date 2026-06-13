# Projection Read-Only Hardening

**Date**: 2026-06-13
**Status**: Accepted (pending PR #1940 merge as Phase 0 prerequisite)
**Owner**: Braden
**Builds on**: `specs/20260612T000201-epicenter-namespace-root-layout.md` (the accepted Epicenter-folder layout, `mountMarkdownPath`, `epicenterRoot`, and the shipped `confineToDir` write fence)
**Supersedes (the live parts of)**: `specs/20260602T200000-vault-read-only-projection-agent-mutation.md` (its write fence and no-readback layers already shipped; its per-file manifest is rejected by the layout spec)

## One Sentence

Finish the "read-only projection, mutate only through validated actions" promise by adding three small, independent layers on top of the already-shipped fence: a per-file `epicenter: generated` marker, a daemon-generated root `AGENTS.md`, and trash-before-delete on rebuild; the mount folder is treated as exclusively Epicenter-owned, and OS-level read-only file mode is deliberately deferred.

## What is already true (do not rebuild)

- **Write fence (shipped):** `mountMarkdownPath(epicenterRoot, mount)` is the only projection path; freeform `markdownDir`/`sqliteFile` are gone. `confineToDir(root, segment)` rejects any write/unlink that escapes the mount folder (`packages/workspace/src/document/materializer/markdown/export.ts`, with tests).
- **No readback (shipped, structural):** there is no code path from `epicenterRoot/<mount>/**/*.md` back into Yjs. The import subsystem is deleted. Editing a generated file cannot mutate app data, full stop.
- **Mutate via actions (shipped):** every mutation runs through `invokeAction`'s TypeBox gate (`packages/workspace/src/shared/actions.ts`); the daemon exposes `/list` and `/invoke` over a unix socket; the agent surface is `epicenter list --format json` and `epicenter run <mount>.<action> <json>` (`packages/cli/src/commands/{list,run}.ts`).

So the current contract is: "editing a generated file is futile and silently reverted on next materialize, and edits can never corrupt app data, but the OS does not block the save." This spec closes the soft edges, not the load-bearing guarantee (which already holds).

## Decisions (resolved 2026-06-13)

| Question | Decision | Why |
| --- | --- | --- |
| Read-only enforcement strength | **Marker now, `chmod 0o444` deferred** | The structural guarantee (no readback) already makes edits harmless. `chmod` adds atomic temp+rename plumbing and a Windows / network-filesystem portability surface; defer until users actually hit edit-then-vanish. |
| Rebuild deletion | **Trash to `.epicenter/trash/<mount>/<timestamp>/`** | Recoverability safety net now that the per-file manifest is dropped. Cheap. |
| File dropped into a mount folder | **Sweep it; the folder is exclusively Epicenter-owned** | Matches layout-spec invariant 5. Simplest contract; the marker + `AGENTS.md` make ownership obvious. Warn-and-skip would re-introduce manifest-like per-file tracking the layout spec rejected. |
| Per-file marker worth a reserved key | **Yes** | Grep-detectable "this is generated" signal that travels with a single matched file, for the agent-lands-on-one-hit case. |
| Generated rule doc location | **Daemon-generated `epicenterRoot/AGENTS.md`** | Under the new layout there is no `apps/` container; the namespace root is the natural home. Must be gitignored/owned, never hand-edited. |

## Implementation Plan

Phase 0 (prerequisite): **PR #1940 merged to main.** All anchors below assume the post-merge shape (`mountMarkdownPath`, `epicenterRoot`, `confineToDir`). Do not duplicate the confinement work; it exists with tests.

**Phase A: `epicenter: generated` marker.** Inject the reserved frontmatter key in the central render closure (`export.ts`, the `render: RenderRow` closure that builds `shape.frontmatter`) so every projection carries it. Guard the key: if a row's own frontmatter already contains `epicenter`, fail that row via the existing `MaterializerWriteError` rather than letting app data overwrite the marker. Tests: marker present; colliding key rejected.

**Phase B: daemon-generated root `AGENTS.md`.** At daemon startup, after mounts resolve, write `epicenterRoot/AGENTS.md` with the one rule (this folder is a read-only projection; mutate via actions), the `epicenter list` / `epicenter run` recipe, and the live mount list (from the same registry that feeds `/list`, `packages/workspace/src/daemon/app.ts`). Coordinate with the layout spec's gitignore model so the file is owned, not hand-edited. Tests: temp-root daemon start writes the file and names configured mounts.

**Phase C (DEFERRED, not this round): OS read-only file mode.** `chmod 0o444` + atomic temp-write/rename in `writeMarkdownFile` (`export.ts`). Revisit only if edit-then-vanish becomes a real complaint. Recorded here so the deferral is explicit.

**Phase D: trash-before-delete on rebuild.** `rebuildTable`'s `readdir(recursive) + unlink` sweep moves files to `epicenterRoot/.epicenter/trash/<mount>/<timestamp>/` instead of unlinking. Add `trashPath(epicenterRoot, mount, timestamp)` in `packages/workspace/src/document/workspace-paths.ts`. Because the primitive may not know `epicenterRoot`/mount, thread that context in or wrap at the mount-factory layer (`apps/*/project.ts`). `confineToDir` still applies. Tests: rebuild moves removed files to trash, never outside the mount.

Order: A and B (cheap, parallel) then D. C stays parked.

## Source of truth

This spec is the single home for the remaining hardening. The parking-branch body of `20260602T200000` is fuller but is built on the rejected manifest and the retired `apps/` container, so it is not promoted; its prose for the marker rationale and the `AGENTS.md` template was harvested here and re-anchored on the Epicenter-folder layout.
