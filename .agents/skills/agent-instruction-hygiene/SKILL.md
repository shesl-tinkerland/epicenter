---
name: agent-instruction-hygiene
description: Review AGENTS.md, CLAUDE.md, and `.agents/skills` for instruction sprawl, duplicated guidance, routing overlap, and misplaced process detail. Use when adding or revising agent instructions, deciding whether a rule belongs globally or in a skill, grilling whether a new skill should exist, or cutting down skill complexity.
---

# Agent Instruction Hygiene

Use this skill when the instruction system itself is the design surface.

The goal is not to capture every lesson. The goal is to keep future agents
pointed at the smallest durable instruction that changes behavior.

## Compose With

- `skill-creator` owns skill format, discovery, validation, and update mechanics.
- `writing-voice` owns prose tone and punctuation.
- `greenfield-clean-breaks` owns compatibility refusal and ideal-shape review.
- `git` owns staging, commits, and branch hygiene.

## Product Sentence

Write this sentence first:

```txt
AGENTS.md routes always-on repo constraints; skills own triggerable workflows; references hold conditional detail; CLAUDE.md shims import AGENTS.md.
```

If the proposed instruction does not fit that sentence, change the placement
before changing the prose.

## Placement Rules

Use this table before editing:

```txt
AGENTS.md      rules every agent must carry before any skill is selected
SKILL.md       repeatable workflow selected by a concrete user intent
references/   long examples or conditional detail loaded only when needed
scripts/      deterministic fragile work better done by code
CLAUDE.md      compatibility shim, usually only @AGENTS.md
delete         one-off advice, taste notes, or rules already owned elsewhere
```

Do not create a new skill when an existing skill already owns the same user
intent. Update the existing skill, narrow its description, or move detail into a
reference instead.

## Greenfield Grill

Ask these questions in order:

```txt
What repeated failure does this prevent?
Which future prompt should trigger this instruction?
Which near-miss prompt should not trigger it?
Who has to carry this text on every task?
Which existing instruction already owns the behavior?
What can be deleted, moved to references, or shortened?
Does the new shape reduce loaded context or only add another place to check?
```

Default to deletion when the answer is "this was useful once." Default to
updating an existing skill when the answer is "same trigger, sharper behavior."
Default to a new skill only when the answer is "separate trigger, repeatable
workflow, and lower total routing cost."

## Output Shape

Before editing, report the decision in this shape:

```txt
Instruction sentence:
  ...

Current surface:
  AGENTS.md / existing skill / reference / absent

Drift:
  duplicated rule / wrong owner / too much detail / missing trigger / one-off note

Decision:
  keep global / update skill / add skill / move to reference / delete

Why this reduces complexity:
  ...
```

## Final Checks

When edits land:

1. Run `bun x --package skills skills add /Users/braden/Code/epicenter/.agents/skills --skill <skill-name> --list` for changed or added skills.
2. Run `git diff --check` on touched instruction files.
3. Check touched prose against the `writing-voice` punctuation rubric.
4. Stage specific files only when the user asks.
