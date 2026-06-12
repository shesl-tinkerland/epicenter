# Skill Discovery And Reference Decomposition

**Date**: 2026-05-18
**Status**: Implemented
**Author**: AI-assisted
**Branch**: codex/consolidate-open-threads

## Overview

This spec captures the current skill cleanup state and defines the next execution wave. The goal is to make repo-local skills easier for agents to discover, validate, and load without bloating `AGENTS.md` or leaving long `SKILL.md` files as catch-all manuals.

## Motivation

### Current State

`AGENTS.md` now carries only short always-on rules. Detailed workflows still belong in `.agents/skills`.

Wave 1 and focused Wave 2 have already been applied in the worktree:

```txt
.agents/skills/spec-execution/SKILL.md
.agents/skills/create-auth-skill/SKILL.md
.agents/skills/autumn/SKILL.md
.agents/skills/email-and-password-best-practices/SKILL.md
.agents/skills/organization-best-practices/SKILL.md
.agents/skills/two-factor-authentication-best-practices/SKILL.md
.agents/skills/svelte/SKILL.md
.agents/skills/typescript/SKILL.md
.agents/skills/frontend-design/SKILL.md
.agents/skills/workspace-api/SKILL.md
.agents/skills/auth/SKILL.md
.agents/skills/better-auth-best-practices/SKILL.md
.agents/skills/better-auth-security-best-practices/SKILL.md
-.agents/skills/write-a-skill/SKILL.md
```

The unrelated dirty files must stay out of this cleanup unless the user explicitly redirects:

```txt
specs/20260413T120000-server-authoritative-apps-wager-social.md
specs/20260518T000000-live-device-dispatch.md
.claude/worktrees/
specs/20260518T160639-theark-marp-shortform-content-engine.md
specs/20260518T180000-open-threads-from-worktree-triage.md
```

This creates problems:

1. **Prompt-only handoff loses state**: A fresh chat cannot know which Wave 1 and Wave 2 edits are already present unless the repo records that context.
2. **Skill discovery is uneven**: `rg --files .agents/skills -g SKILL.md` lists more skills than the Vercel skills CLI finds. After Wave 2, full validation finds 65 skills, but there are still repo-local skills outside that discovery surface.
3. **Large skill bodies are expensive to load**: `svelte`, `typescript`, and `workspace-api` contain substantial reference material that should probably move behind `references/`.

### Desired State

Agents should be able to do this from disk:

```txt
read AGENTS.md
read this spec
inspect Wave 1 and Wave 2 diff
validate skill discovery
fix frontmatter discovery gaps
decompose the largest obvious skill bodies
verify with skills CLI and git diff checks
```

## Research Findings

### AGENTS.md Versus Skills

OpenAI Codex docs treat `AGENTS.md` as always-on repository guidance. OpenAI and Claude skill docs both treat skills as task-specific capabilities selected from descriptions and loaded only when relevant.

**Key finding**: Short global safety rules belong in `AGENTS.md`; detailed procedures belong in skills.

**Implication**: Wave 3 should not add more broad policy to `AGENTS.md` unless a rule is needed before skill selection.

### Vercel Skills CLI Discovery

The validation command is:

```bash
bun x --package skills skills add /Users/braden/Code/epicenter/.agents/skills --list
```

During Wave 2, individual validation failed for several touched skills because unquoted YAML descriptions contained colons. Quoting those descriptions fixed the touched skills. Full-folder validation then reported:

```txt
Found 65 skills
```

**Key finding**: Discovery failures may be frontmatter syntax, not skill content.

**Implication**: Wave 3 should audit missing skills by frontmatter first before rewriting bodies.

## Design Decisions

| Decision | Class | Choice | Rationale |
| --- | --- | --- | --- |
| Root policy size | 2 coherence | Keep `AGENTS.md` compact | Root rules are always loaded; long workflows belong in skills. |
| `write-a-skill` | 2 coherence | Delete it | `skill-creator` is repo-specific and validates the Vercel-backed format. Keeping both creates duplicate triggers. |
| Wave 2 scope | 3 taste | Tighten descriptions only | Description edits improve discovery without mixing in large body decomposition. |
| Wave 3 first task | 1 evidence | Compare `rg --files` with skills CLI output | Missing skills should be proven before changing frontmatter. |
| Decomposition targets | 2 coherence | Start with `svelte`, `typescript`, `workspace-api` | These are large, frequently used, and likely contain reference material that can move behind links. |

## Architecture

The intended skill shape is:

```txt
.agents/skills/<skill>/
|-- SKILL.md
|   |-- frontmatter with name and quoted description when needed
|   |-- core triggers and rules
|   |-- decision points
|   `-- links to references
`-- references/
    |-- long examples
    |-- tables
    |-- edge cases
    `-- migration notes
```

`SKILL.md` should answer:

```txt
When should this skill load?
What rules must guide the first pass?
Which reference file should be opened for deeper detail?
What should make the agent pause?
```

## Implementation Plan

### Phase 0: Preserve Current State

- [x] **0.1** Read `AGENTS.md`.
- [x] **0.2** Read this spec.
- [x] **0.3** Run `git status --short` and list unrelated dirty files that must stay untouched.
- [x] **0.4** Inspect the current Wave 1 and Wave 2 diff for `.agents/skills`.

### Phase 1: Validate Discovery

- [x] **1.1** List every repo-local skill file:

  ```bash
  rg --files .agents/skills -g SKILL.md
  ```

- [x] **1.2** Run full Vercel skills CLI validation:

  ```bash
  bun x --package skills skills add /Users/braden/Code/epicenter/.agents/skills --list
  ```

- [x] **1.3** Compare the filesystem list against the CLI-discovered names.
- [x] **1.4** Classify each missing skill as:
  - intentionally internal or disabled
  - invalid frontmatter
  - unsupported by Vercel CLI for another reason
  - should be deleted or merged, but pause before deletion

### Phase 2: Fix Frontmatter Discovery Gaps

- [x] **2.1** For each missing skill, inspect only the frontmatter first.
- [x] **2.2** Quote descriptions that contain YAML-sensitive characters such as colons.
- [x] **2.3** Keep `description` trigger-focused: capability first, then exact trigger situations.
- [x] **2.4** Do not rewrite body content during this phase unless the frontmatter points to stale skill names.
- [x] **2.5** Re-run individual validation for every fixed skill.
- [x] **2.6** Re-run full validation and record the discovered count.

### Phase 3: Decompose Large Skill Bodies

- [x] **3.1** Start with `svelte`.
  - Move long examples, detailed anti-pattern walkthroughs, and rare edge cases into `references/`.
  - Keep `SKILL.md` focused on core rules, decision points, and links.
- [x] **3.2** Repeat for `typescript`.
  - Preserve concrete rules that agents need immediately.
  - Move long rationale and advanced examples into `references/`.
- [x] **3.3** Repeat for `workspace-api`.
  - Keep schema, action, and attachment routing rules in the body.
  - Move long CRUD, migration, primitive, and action-return details into references if not already split.
- [x] **3.4** Stop after those three decompositions unless the user explicitly asks to continue into auth skills.

### Phase 4: Verification

- [x] **4.1** Run full validation:

  ```bash
  bun x --package skills skills add /Users/braden/Code/epicenter/.agents/skills --list
  ```

- [x] **4.2** Run focused greps:

  ```bash
  rg -n "write-a-skill|write a skill" .agents AGENTS.md docs specs packages apps
  rg -n "\b(npm|npx|bunx)\b" .agents/skills
  ```

- [x] **4.3** Run:

  ```bash
  git diff --check -- .agents/skills
  ```

- [x] **4.4** Re-read every touched file before final response.

## Edge Cases

### Codex-Only Skills

Some skills may intentionally exist for Codex but not validate through the Vercel CLI. Do not force compatibility if that would remove useful Codex-only metadata. Record the reason and leave it alone.

### Internal Skills

Internal bootstrap skills should not be made discoverable unless their purpose is normal task execution. If setup is one-time repo plumbing, delete the skill after setup instead of carrying a hidden routing surface.

### Reference Moves Can Break Links

When moving sections into `references/`, update all relative links. Validate by grepping for moved headings or stale filenames.

## Open Questions

1. Should all repo-local skills be Vercel CLI discoverable, or should some remain Codex-only?
2. Should Wave 3 include auth/security/org/2FA decomposition, or should those become Wave 4 after `svelte`, `typescript`, and `workspace-api`?
3. Should the final Wave 3 commit include the already-applied Wave 1 and Wave 2 changes, or should those be committed first as a smaller review unit?

## Review

**Completed**: 2026-05-19
**Branch**: codex/consolidate-open-threads

### Summary

Wave 3 fixed Vercel skills CLI discovery gaps caused by YAML-sensitive descriptions, raising full-folder discovery from 65 skills to 88 skills. At the time, two repo-local skill files remained intentionally hidden by frontmatter. A later instruction-hygiene pass removed the bootstrap skill and folded the zoom-out trigger into `notebook-explanation`.

The largest three skill bodies were decomposed. `svelte`, `typescript`, and `workspace-api` now keep compact trigger rules and first-pass decisions in `SKILL.md`, with detailed examples and edge cases moved into `references/`.

### Verification

- `bun x --package skills skills add /Users/braden/Code/epicenter/.agents/skills --list`: found 88 skills.
- Individual validation passed for the 23 frontmatter-fixed skills.
- Individual validation passed for `svelte`, `typescript`, and `workspace-api`.
- `rg -n "\b(npm|npx|bunx)\b" .agents/skills`: no matches after replacing the moved `bunx` command.
- `git diff --check -- .agents/skills`: passed.

### Follow-up Work

- Decide in a later wave whether auth/security/org/2FA skills should be decomposed.
- Continue deleting or folding hidden skill surfaces when an existing discoverable skill can own the same trigger.
