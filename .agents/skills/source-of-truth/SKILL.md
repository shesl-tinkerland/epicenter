---
name: source-of-truth
description: Extract code on source-of-truth grounds, not on DRY grounds. Use when deciding whether to extract a helper, lift duplicated logic into a shared module, or pass on extraction even though two snippets look alike. Apply during refactoring audits, code review, and design reviews.
metadata:
  author: epicenter
  version: '1.0'
---

# Extract for Source of Truth, Not for DRY

This codebase does not believe in "don't repeat yourself" as a motivation. We believe in single source of truth. The two principles agree most of the time but diverge in the cases that matter, and DRY pulls you toward the wrong move when they diverge.

> **Background article**: `docs/articles/20260429T225829-dry-isnt-the-goal-source-of-truth-is.md` walks through the reframe in long form.

## The Question

Before extracting any duplicated body, ask:

> If I change this body, does the other copy have to change in the same way?

- **Yes**: those copies share a single decision in your head. Extract, name the concept, document the rule. The duplication is a maintenance liability waiting to drift.
- **No**: the copies happen to look alike. Leave them inline. They share syntax, not semantics, and forcing them through a shared abstraction couples decisions that should stay independent.

## When to Extract (Yes-Cases)

Extract when you can name a concept that owns the rule, and when changing that rule means every copy must change.

```ts
// YES: "our standard concurrency pragma setup for writer-side SQLite files"
//   adding wal_autocheckpoint requires both writers to update.
//   tightening the WAL verification check requires both writers to update.
function applyWriterPragmas(db: Database, log: Logger): void {
  // PRAGMA journal_mode = WAL, synchronous = NORMAL, busy_timeout = 5000,
  // verify the WAL pragma actually took, log on silent fallback...
}
```

The concept has a name. The rule lives in our codebase, not in some external standard. If we change the rule once, we want every consumer to pick up the change automatically.

Other yes-cases:

- A schema definition consumed by both server and client. Drift here is a bug.
- An error code or status enum referenced from multiple modules. Adding a variant must propagate.
- A computation derived from project-specific constants (rate limits, timeouts, retry counts).
- A wire format encode/decode pair. The two sides must stay aligned.

## When NOT to Extract (No-Cases)

Don't extract when the "shared" rule lives outside the codebase, or when the snippets are doing structurally different things that happen to read the same.

```ts
// NO: SQL identifier escaping is a universal rule, not a project decision.
function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}
// If this lives in two files, they will agree forever. There is no
// scenario where one copy needs to diverge from the other. Extracting
// just adds a cross-module dependency for a function that needs no
// synchronized maintenance.
```

Other no-cases:

- Three test setups that build similar fixtures but test independent behaviors. Each setup is downstream of its own test, not a shared rule. Coupling them is a maintenance trap, not a save.
- Three switch arms that read alike but model different domain concepts. The visual similarity is incidental.
- Two error messages with identical wording for unrelated failures. Different decisions, same English coincidence.
- Inline boilerplate that is shorter to read in place than to chase through a helper.

## The Smell That Tricks You

The trap is the word "similar." Visual similarity is what you notice first because it's cheap. Semantic singularity is what actually predicts pain, but it requires reading the code, not scanning it.

Train yourself to slow down past the visual hit:

1. See the duplication.
2. Try to name the concept the copies share.
3. If the name is "the same code as the other place," there's no concept. Leave it.
4. If the name is "the project's rule for X," that's your concept. Extract.

## The Bias

When uncertain, lean inline. Premature extraction is harder to undo than late extraction:

- **Late extraction** is local. Find the third caller, lift the body, replace three call sites. Reversible.
- **Premature extraction** is global. Every call site is now coupled through your abstraction. Unwinding it means re-inlining at every site, often through layers of glue you added to make the abstraction work.

A note saying "TODO: extract once a third caller appears" costs nothing. A wrong abstraction costs every future change.

## Three Similar Lines

The codebase rule "three similar lines is better than a premature abstraction" is the no-case in compressed form. It only sounds in tension with DRY. With source of truth as the frame, the two are the same principle:

- Three similar lines that share a source of truth: one decision wearing three masks. Extract.
- Three similar lines that happen to look alike: three independent decisions with a coincidence. Inline.

The rule of thumb biases against extraction because the failure mode of inline-too-long (mild duplication, easy fix later) is much cheaper than the failure mode of extract-too-soon (wrong shared abstraction, painful unwind).

## How to Phrase the Decision in PRs

When you do extract, lead with the concept, not with the duplication count.

> **Bad PR description**: "Refactor: extract `applyWriterPragmas` to remove duplication."
>
> **Good PR description**: "Lift `applyWriterPragmas` so the project's standard writer-side SQLite concurrency setup lives in one place. Both `attachYjsLog` and `attachSqlite` now consume it; future changes to the pragma triple update both writers automatically."

The good description names the concept and explains why the extraction is load-bearing. A reviewer can disagree with the concept (and reject the extraction) instead of being forced to argue against an aesthetic preference.

When you decline to extract despite visible duplication, leave a comment explaining the no-case so the next reader doesn't refile the cleanup PR.

```ts
// Locally duplicated with attachSqlite's quoteIdentifier.
// SQL escaping is a universal rule, not a project decision; the two
// copies will never need to diverge. Extracting just couples modules
// for no maintenance benefit.
function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}
```

## Related Skills

- `refactoring`: tactics for caller counting, inlining single-use extractions, and collapsing duplicate branches. This skill is the *why*; refactoring is the *how*.
- `one-sentence-test`: a complementary lens. If you can describe a helper in one sentence, it has a concept; if the sentence is "the same code as that other place," it doesn't.
