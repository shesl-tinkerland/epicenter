# Architecture Decision Records

An ADR captures one durable decision: the forces that made it necessary, what we
decided, and what that costs. ADRs are the authoritative record of *why* the
system is shaped the way it is. Specs explore options; an ADR records the one
outcome we committed to.

This is the layer agents and humans should trust for decisions. If a spec in
`specs/`, a row in `docs/spec-history.md`, or an old comment disagrees with an
accepted ADR, the ADR wins.

## Rules

- **One decision per record.** If you are documenting several decisions, write
  several ADRs.
- **Immutable once accepted.** Do not edit a decision out of an accepted ADR. To
  change direction, write a new ADR, set its `Supersedes` to the old one, and set
  the old one's `Superseded by` to the new one. The chain is the history.
- **Concise and outcome-focused.** An ADR is not a spec. State the decision so a
  reader can act on it without reading the exploration. Link the spec for the
  deep evidence if it still exists; otherwise cite the git ref.
- **Status is one of:** `Proposed`, `Accepted`, `Superseded`.
- **Decisions are born from specs but do not live there.** When a design pass
  settles something durable, harvest it into an ADR and let the spec be deleted.
- **`Proposed` is a transient state.** Record a decision as `Proposed` when it
  crystallizes during design; flip it to `Accepted` when the work lands. A
  `Proposed` ADR that no in-tree spec references means its spec was deleted (the
  work landed): flip it, or supersede it if abandoned. `bun
  scripts/check-doc-hygiene.ts` flags orphaned and stale `Proposed` ADRs.

## Numbering

`NNNN-kebab-decision-as-sentence.md`, zero-padded, monotonically increasing. The
title is the decision stated as a declarative sentence, so the filename alone
reads as the conclusion.

## Template

```markdown
# NNNN. <decision stated as one declarative sentence>

- **Status:** Proposed | Accepted | Superseded
- **Date:** YYYY-MM-DD
- **Supersedes:** [ADR-MMMM](MMMM-*.md) (or omit)
- **Superseded by:** [ADR-PPPP](PPPP-*.md) (added only when this is retired)

## Context

The forces in play: what was true, what pressure forced a decision. No survey of
alternatives yet, just why a decision was needed. Two to five sentences.

## Decision

The single thing we decided, in active voice, present tense. A reader should be
able to act on this paragraph alone.

## Consequences

What becomes true, easier, harder, or deleted as a result. Name the trade-off
honestly, including what this forecloses.

## Considered alternatives  (optional)

Each option and the one reason it lost. Terse. This is not the spec.
```

## Index

| ADR | Decision | Status |
|-----|----------|--------|
| [0001](0001-classified-scan-read-surface.md) | One classified `scan()`, no valid-only default read | Accepted (bucket list amended by 0003) |
| [0002](0002-four-visible-read-states.md) | Stored entries reconcile to four visible read states | Superseded by 0003 |
| [0003](0003-three-read-states-after-encryption-removal.md) | Stored entries reconcile to three visible read states | Accepted |
| [0004](0004-trust-the-relay-reject-zero-knowledge.md) | Trust the relay; reject zero-knowledge | Accepted |
| [0005](0005-child-docs-are-bound-through-the-workspace.md) | Child docs are bound through the workspace, not the component | Accepted |
| [0006](0006-schema-evolution-keeps-the-version-tuple-and-refuses-repair-apis.md) | Schema evolution keeps the version tuple and refuses repair APIs | Accepted |
| [0007](0007-local-shortcuts-sync-global-shortcuts-stay-per-device.md) | Local shortcuts sync, global shortcuts stay per-device | Accepted |
| [0008](0008-rdev-backs-the-desktop-global-trigger.md) | rdev backs the desktop global trigger | Accepted |
| [0009](0009-the-cli-dispatches-through-a-mandatory-daemon.md) | The CLI dispatches through a mandatory daemon; automation lives in library scripts | Accepted |
| [0010](0010-actions-are-the-only-surface-that-crosses-a-process-boundary.md) | Actions are the only surface that crosses a process boundary | Accepted |
| [0011](0011-rust-owns-the-macos-dictation-capability.md) | Rust owns the macOS dictation capability; the frontend is a view over it | Accepted |
| [0012](0012-transcription-settings-are-read-at-use-not-mirrored-into-rust.md) | Transcription settings are read at use; Rust's model cache owns mechanism, not config | Accepted |
| [0013](0013-transformations-split-into-automatic-cleanup-and-a-portable-format-library.md) | Transformations split into an automatic Cleanup layer and a portable Format library | Proposed |

When you add an ADR, add its row here.
