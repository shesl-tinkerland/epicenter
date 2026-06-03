# Agents Read the Projection, Write Through Actions

**Date**: 2026-06-03
**Status**: Draft
**Owner**: Braden
**Extends**: `20260602T200000-vault-read-only-projection-agent-mutation.md`
**Grounded in**: `docs/articles/two-kinds-of-ai-editing.md`, `every-ai-editor-converges-on-str-replace.md`, `every-ai-editor-flattens-the-tree.md`, `liveblocks-flatten-diff-pattern.md`

## How to read this spec

```txt
Read first:
  One Sentence
  The two kinds of AI editing (the frame for everything)
  Current State
  Target Shape (The Contract)
  The Agent Action Surface (catalog)
  Implementation Plan

Read if changing the design:
  Design Decisions
  Body model: Y.Text for the agent path
  Enforcement layers
  Open Questions

Skip unless curious:
  Research Findings
  Edge Cases
  Decisions Log
```

## One Sentence

Coding agents read the read-only materialized markdown projection to orient, and mutate **exclusively** through validated actions: structural changes via named semantic verbs, prose via one text-diff apply engine over `Y.Text` bodies, so there is never a second writer and never a lossy round-trip.

## The two kinds of AI editing (the frame for everything)

This spec governs **one** of two editing contexts, named in `docs/articles/two-kinds-of-ai-editing.md`. Conflating them is what makes body editing look hard. They want opposite storage.

```txt
INTERACTIVE COPILOT                      EXTERNAL AGENT  <-- THIS SPEC
─────────────────────────────────       ─────────────────────────────────
user highlights in a WYSIWYG editor,     Claude Code / Codex reads a file,
AI rewrites the selection                reasons, writes text back
frozen snapshot + human-gated merge      LIVE doc, concurrent, no human gate
flatten-diff against the schema          text diff -> character ops that
(Liveblocks pattern)                     compose with the CRDT natively
wants Y.XmlFragment (rich tree)          wants TEXT as source of truth
lives in honeycrisp / fuji TODAY         lives in the vault / agent world
```

**Consequence**: body storage is not a platform-global choice. It is a per-app consequence of which context is primary. honeycrisp/fuji are copilot-primary and keep `Y.XmlFragment`. The vault is agent-primary and should use `Y.Text` (see Body model). This spec does not touch the copilot apps.

## Overview

Defines the agent-facing contract for an agent-primary workspace (the vault): which surface an agent reads, which surface it writes through, how that rule is enforced rather than requested, and how an agent edits a prose body without round-tripping a file. Introduces a semantic action vocabulary plus a single text-diff body apply engine (`body_set` / `body_patch`). Does **not** reintroduce the bidirectional disk-to-Yjs subsystem deleted in `20260602T200000`.

## Motivation

### Current State

```txt
SOURCE OF TRUTH     Yjs CRDT store (tables, KV, body docs)
      │
      ▼  one-way, no apply
PROJECTION          materialized .md files under apps/**
      │
      ▼
AGENT READS         Read / Grep / Glob          (native, read-only)
AGENT WRITES        epicenter run <mount>.<action>   (validated)
```

Verified anchors:

- One-way projection, explicitly no apply: `packages/workspace/src/document/materializer/markdown/export.ts:13-21`.
- Single validated choke point `invokeAction` (returns `result.data`): `packages/workspace/src/shared/actions.ts:417-437` (TypeBox `Value.Check`).
- CLI `run` already accepts inline JSON, `@file.json`, and **stdin**: `packages/cli/src/commands/run.ts` (`resolveInput`).
- CLI `list --format json` already exists: `packages/cli/src/commands/list.ts:29-51`.
- Three consumers already route through the choke point: daemon `action-handler.ts:66`, dispatch `dispatch.ts:290`, AI tool-bridge `ai/tool-bridge.ts:147-151`.
- Body primitives: `attachRichText` (Y.XmlFragment) `attach-rich-text.ts:30-49`; `attachPlainText` (Y.Text) `attach-plain-text.ts`. Codec: `packages/filesystem/src/formats/markdown.ts:88-106`.
- Live WYSIWYG editors (copilot context, untouched): `apps/honeycrisp/src/lib/editor/Editor.svelte`, `apps/fuji/src/routes/(signed-in)/components/EntryBodyEditor.svelte`.

Gaps:

1. **The write rule is prompt-only.** `vault/AGENTS.md` says "never hand-edit `apps/**`," but nothing stops an agent's `Write`/`Edit` tool from doing it (then the next rebuild silently overwrites it).
2. **No clean body-write story.** Small typed fields map to `run <mount>.update`; a prose body does not. This is the pressure that tempts a round-trip back into the design.
3. **CLI-vs-MCP and the body model keep recirculating.** Settle both.

### Desired State

> Agents read the materialized folder and mutate through `epicenter run <mount>.<action>`: structural fields via named verbs, prose via `body_set`/`body_patch` over `Y.Text`, every `apps/**` file read-only and self-documenting its own mutate command, and the action result is the read-your-writes (no re-grep).

## Research Findings

### Your own articles already decided the body model

| Article | Load-bearing claim |
| --- | --- |
| `every-ai-editor-converges-on-str-replace.md` | Every production AI tool converged on text search/replace. "Rich editing is a view on the text, not the source of truth. `readFile()` returns plain text, `writeFile()` applies text diffs." |
| `every-ai-editor-flattens-the-tree.md` | The tree stays editor-side, text stays AI-side, markdown is the bridge. Sophistication lives in the **apply step**, not the format. |
| `two-kinds-of-ai-editing.md` | Copilot = flatten-diff on a snapshot. Agent = text diff -> character ops that compose with concurrent CRDT edits. Build for both; do not pretend one solution covers both. |
| `liveblocks-flatten-diff-pattern.md` | Ask the AI for the whole new version, reconstruct the diff algorithmically. (This is the copilot path, not the agent path.) |

**Key finding**: for the external-agent path, text is the source of truth and the body should be flat markdown the agent reads verbatim. `Y.XmlFragment` forces a lossy serialize/parse and makes `body_patch` a fragment re-derivation (no merge benefit). `Y.Text` makes `body_patch` a true positional delta that composes with concurrent edits, which is exactly what `two-kinds-of-ai-editing.md` prescribes for agents.

**Implication**: use `Y.Text` for vault/agent bodies. The materialized file is the `Y.Text` verbatim, so agent anchors always match.

### CLI versus MCP

| What MCP adds over CLI | CLI status today | Verdict |
| --- | --- | --- |
| Schemas pushed to the agent | `list --format json` + one AGENTS.md line (pull) | Covered, cheaply |
| Structured args, no shell escaping | `run` already takes stdin + `@file.json` | **Already solved** |
| Works in a shell-less client | CLI needs a shell | **Only real MCP win** |

**Key finding**: MCP is ~90% redundant with the CLI in any shelled environment; the escaping win is already implemented in `run.ts`. MCP earns its keep only for a shell-less client (browser-hosted instance), where it is a fourth thin adapter over `invokeAction`. **Defer it.** This also dodges the fact that Codex lacks Claude Code's per-path deny (see Enforcement).

## Design Decisions

| Decision | Class | Choice | Rationale |
| --- | --- | --- | --- |
| Read surface | 2 coherence | Materialized `.md`, read-only | Native agent search idiom; projection exists |
| Write surface | 2 coherence | `epicenter run <mount>.<action>` only | Single validated choke point; no second writer |
| Structural writes | 2 coherence | Named semantic verbs (`set_status`, `add_tag`, ...) | Zero ambiguity, no diffing, merge-trivial; the agent states intent |
| Prose writes | 1 evidence | One text-diff apply engine; `body_set` + `body_patch` shapes | Matches the str_replace convergence in your own articles |
| **Body model (agent apps)** | **1 evidence** | **`Y.Text` (raw markdown), not `Y.XmlFragment`** | `every-ai-editor-converges-on-str-replace.md`: text is the source of truth; gives surgical, merge-composable patches |
| Body model (copilot apps) | 2 coherence | Keep `Y.XmlFragment` + flatten-diff | honeycrisp/fuji are copilot-primary; out of scope here |
| CLI vs MCP | 1 evidence | CLI now; MCP deferred | `run.ts` already does stdin/`@file`; MCP only for shell-less clients |
| Round-trip / file-edit-then-reconcile | 2 coherence | Rejected | Two writers + lossy parse, deleted in `20260602T200000` |
| Enforcement scope | 1 evidence | Deny writes to `apps/**` only, not all markdown | Agents must still edit user files (`imessage/`, etc.) |
| Audit + dry-run | 3 taste | Log `{action,input,ts}`; offer `--dry-run` | The choke point makes mutations observable and previewable |
| Self-documenting files | 3 taste | Stamp mutate command (agent) + deep link (human) | Read surface hands off to write surface, per audience |

## Target Shape (The Contract)

```txt
1. ORIENT     Read / Grep the materialized folder            (read-only, native)
2. MUTATE     epicenter run <mount>.<action> [stdin|@file]   (validated, single writer)
3. CONFIRM    trust the action's returned data               (read-your-writes; no re-grep)
```

Honest asymmetry (do not unify behind a "mode" discriminator):

```txt
ONE write path:  actions via `run`   (structural = verbs, prose = diff engine)
TWO read paths:  grep files (fuzzy)  +  query action (structured)
```

## The Agent Action Surface (catalog)

```ts
// READ (structured complement to grep)
<mount>.list / get / query                 // --format json

// WRITE structural  (named verbs; agent states intent, no text diff)
<mount>.set_status   --id X --status published
<mount>.add_tag      --id X --tag draft
<mount>.set_destination --id X --to instagram
<mount>.update       --id X --title "..."   // generic field set for the long tail

// WRITE prose  (ONE text-diff apply engine, TWO input shapes, over Y.Text)
<mount>.body_set     --id X (stdin|@file)            // whole rewrite; diff + apply char ops
<mount>.body_patch   --id X --old ".." --new ".."    // anchored str_replace; same engine
```

### Considered and rejected

| Candidate | Why rejected |
| --- | --- |
| Body as `Y.XmlFragment` for agent apps | Lossy serialize/parse; `body_patch` becomes a fragment re-derivation with no merge benefit |
| Asking the agent to emit CRDT/tree/ProseMirror ops | `every-ai-editor-converges-on-str-replace.md`: LLMs cannot reliably produce structural positions |
| Generic `workspace.body_set(guid)` | Body-docs clean break refused generic doc verbs; keep app-owned + typed |
| `epicenter body-edit` top-level CLI verb | `epicenter apply` was removed in favor of `run <mount>.<action>` |
| Markdown round-trip / `markdown_apply` for bodies | Two writers + lossy parse; deleted in `20260602T200000` |
| MCP server (now) | Redundant with CLI; only needed for shell-less clients |
| Deny all markdown edits | Agents must edit user files; scope deny to `apps/**` |

### Self-documenting projection (audience-aware stamp)

```markdown
---
id: 9z6dxc2x
title: My draft
status: draft
---
<!-- generated, read-only. agent: epicenter run pages.set_status --id 9z6dxc2x --status X -->
<!--                        agent: epicenter run pages.body_set --id 9z6dxc2x  (stdin) -->
<!--                        human: epicenter://pages/9z6dxc2x  (edit in app) -->

Body the agent reads verbatim (this IS the Y.Text)...
```

## Body model: Y.Text for the agent path

One apply engine, two input shapes. Both reduce to "produce target text, diff against current `Y.Text`, apply character ops" (the `two-kinds-of-ai-editing.md` agent prescription).

```ts
// body_set: whole rewrite (LLMs are good at rewriting)
body_set: defineMutation({
  input: Type.Object({ id: PageId, markdown: Type.String() }),
  handler: ({ id, markdown }) => applyTextDiff(bodyText(id), markdown), // Y.Text delete/insert
}),

// body_patch: anchored str_replace (mirrors Claude Code / Codex edit tools)
body_patch: defineMutation({
  input: Type.Object({ id: PageId, old: Type.String(), next: Type.String() }),
  handler: ({ id, old, next }) => {
    const text = bodyText(id);                 // Y.Text
    const i = text.toString().indexOf(old);
    if (i < 0) throw AnchorNotFound;           // staleness guard, fails loud
    text.delete(i, old.length);                // surgical, composes with concurrent edits
    text.insert(i, next);
  },
}),
```

`applyTextDiff` is the engine the articles point at: LCS/char diff of current vs target, emitted as `Y.Text` insert/delete at positions. Insert at 42 and insert at 200 do not conflict; the CRDT merges concurrent edits natively. No `Y.XmlFragment`, no codec, no re-parse.

## Enforcement layers

Soft alone is not enough, but note: the projection is **regenerable** (`markdown_rebuild`), so corruption is recoverable. Enforcement is mostly about *feedback* ("that will not persist, use the action"), not preventing data loss. **Scope every deny to `apps/**`**, never all markdown.

```txt
1. AGENTS.md rule           soft   agent-agnostic   have it
2. Claude Code permissions  hard   CC only          deny Write/Edit on apps/**,
   + PreToolUse hook                                 allow Bash(epicenter run|list:*)
3. Codex sandbox            hard   Codex            COARSE: sandbox levels, not per-path;
                                                     use OS read-only or MCP-write-only
4. chmod -R a-w apps/**      hard   agent-agnostic   blunt backstop; daemon re-locks
5. MCP = the only write     hard   agent-agnostic   DEFER (shell-less clients)
   tool (read-only FS)
```

Claude Code `.claude/settings.json`:

```json
{ "permissions": {
    "deny": ["Write(apps/**)", "Edit(apps/**)"],
    "allow": ["Bash(epicenter run:*)", "Bash(epicenter list:*)", "Read", "Grep"]
} }
```

Codex governs writes by sandbox level (`read-only` / `workspace-write` / `danger-full-access`) and approval policy in `~/.codex/config.toml`, **not** per-path tool allow/deny. So `apps/**`-scoped denial is not native there: rely on OS read-only on `apps/**` or the MCP-write-only path. Verify exact Codex keys against the installed version before writing config.

## Vault AGENTS.md good practices

The vault's `AGENTS.md` should tell any coding agent:

1. **`apps/**` is generated and read-only.** Read/grep it freely. Never write it. Everything else (`imessage/`, `pull-request-writing/`) is your normal plain-markdown to edit as files.
2. **Mutate `apps/**` data only via** `epicenter run <mount>.<action>`. Discover the surface with `epicenter list --format json`.
3. **Big payloads go through stdin or `@file.json`**, never inline shell JSON.
4. **Trust the action's returned data** as the new state; do not immediately re-grep a possibly-stale file.
5. **Structural change = named verb** (`set_status`, `add_tag`). **Prose change = `body_set` / `body_patch`**.
6. **If you think you corrupted a generated file**, run `markdown_rebuild`; truth lives in the store.

## Implementation Plan

### Phase 0: Decide the body model (prerequisite)

- [ ] **0.1** Confirm vault bodies are `Y.Text` (agent-primary). honeycrisp/fuji keep `Y.XmlFragment`. (Recommendation: yes.)

### Phase 1: The apply engine + body actions

- [ ] **1.1** `applyTextDiff(yText, targetMarkdown)`: char/LCS diff -> `Y.Text` insert/delete.
- [ ] **1.2** `body_set` (stdin) and `body_patch` (anchored, `AnchorNotFound`/`AnchorAmbiguous`).
- [ ] **1.3** Verify the loop end to end on one app, then `markdown_rebuild` and re-read.

### Phase 2: Semantic verbs + self-documenting files

- [ ] **2.1** Add the structural verbs the target app actually needs (status/tags/destinations).
- [ ] **2.2** Stamp the audience-aware mutate commands into `toMarkdown` (HTML comments, never round-tripped).
- [ ] **2.3** Write the vault `AGENTS.md` good-practices block.

### Phase 3: Enforcement

- [ ] **3.1** Claude Code `settings.json` deny `apps/**` + allow `epicenter`; `PreToolUse` redirect hook.
- [ ] **3.2** OS read-only backstop for non-Claude-Code harnesses (Codex).

### Deferred

- MCP server over `invokeAction` (OQ3): build at the first shell-less client.
- Audit log + `--dry-run` (nice-to-have; the choke point makes both cheap later).

## Edge Cases

### Stale read before write
Single-user sequential is fine; `body_patch` anchor check fails loud if the read was stale; trust the action return rather than re-grepping.

### Anchor not unique / not found
`body_patch` throws; agent falls back to `body_set`. Never silently corrupt.

### Concurrent body edits (the reason for Y.Text)
Agent rewrites paragraph 7 while a peer edits paragraph 3. `Y.Text` char ops at disjoint positions merge; both survive. (A whole-fragment overwrite would lose the peer's edit; this is the `two-kinds` concurrent-deletion problem.)

### Rename / identity
No file rename; `update --id X --title ...`. The slug is projection cosmetics; identity is the row id.

## Open Questions

1. **Vault body model: `Y.Text` confirmed?** Options: (a) `Y.Text` for agent apps [recommended], (b) keep `Y.XmlFragment` everywhere, (c) per-app. Recommendation: (a); leave the copilot apps on `Y.XmlFragment`. Open.
2. **Ship `body_patch` or `body_set` only first?** Recommendation: both; `body_set` is the safe default, `body_patch` the token-cheap surgical path. Open.
3. **When does MCP get built?** Recommendation: first shell-less client. Open.
4. **Diff granularity in `applyTextDiff`** (char vs word vs line LCS)? Recommendation: start line+char hybrid; tune by feel. Open.

## Adjacent Work

- **The post pipeline is the priority, not this.** `draft.md` -> Marp -> carousel never calls `body_set`. Build Phase 1 only when an agent is actually editing bodies, which is after a post ships.
- **`packages/filesystem` as a live virtual FS** is the eventual read-path unification (no materialization lag). Out of scope; does not change the body model.
- **Copilot path (honeycrisp/fuji)** keeps flatten-diff over `Y.XmlFragment`; this spec deliberately leaves it alone.

## Decisions Log

- Keep `Y.XmlFragment` in copilot apps while vault uses `Y.Text`: two contexts, two correct answers (`two-kinds-of-ai-editing.md`).
  Revisit when: a single app needs to be both agent-primary and WYSIWYG-primary on the same body.
- Keep CLI as the sole write transport (no MCP): every current client has a shell.
  Revisit when: a browser-hosted / shell-less agent client ships.

## Success Criteria

- [ ] An agent sets a status and rewrites + tweaks a body using only `Read`/`Grep` + `epicenter run`, never writing under `apps/**`.
- [ ] Vault bodies are `Y.Text`; `body_patch` is a positional delta that survives a concurrent peer edit.
- [ ] Structural changes use named verbs, not text diffs.
- [ ] A blocked `Write`/`Edit` on `apps/**` (Claude Code) returns the redirect; edits outside `apps/**` still work.
- [ ] Each generated file shows its agent command and human deep link.
- [ ] No markdown-to-store reconcile path exists; the projection stays one-way.

## References

- `docs/articles/two-kinds-of-ai-editing.md`, `every-ai-editor-converges-on-str-replace.md`, `every-ai-editor-flattens-the-tree.md`, `liveblocks-flatten-diff-pattern.md` - the editing-model grounding
- `packages/workspace/src/shared/actions.ts:417-437` / `:270-301` - `invokeAction`, `defineMutation`
- `packages/cli/src/commands/run.ts` (`resolveInput`) / `list.ts:29-51` - stdin/`@file`, `--format json`
- `packages/workspace/src/document/attach-plain-text.ts` - `Y.Text` body primitive (the agent-path choice)
- `packages/workspace/src/document/attach-rich-text.ts:30-49` - `Y.XmlFragment` (copilot apps)
- `apps/honeycrisp/src/lib/editor/Editor.svelte`, `apps/fuji/.../EntryBodyEditor.svelte` - copilot editors left untouched
- `packages/workspace/src/document/materializer/markdown/export.ts:13-21` - one-way projection, no apply
- `specs/20260602T200000-vault-read-only-projection-agent-mutation.md` - the one-way clean break this extends
