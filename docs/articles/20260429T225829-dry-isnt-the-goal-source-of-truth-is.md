# DRY Isn't the Goal. Single Source of Truth Is.

Two functions in the codebase had the same body. The same eight lines, just calling errors out of two different namespaces. The DRY voice in your head says: extract. The honest question is different.

The honest question is: if I change one of these copies, does the other one have to change too?

If yes, those copies share a single source of truth. The duplication isn't a code smell, it's a maintenance liability. Extract.

If no, they happen to look alike right now. Maybe forever, maybe not. Inline.

DRY ("don't repeat yourself") measures syntax. Source of truth measures semantics. They mostly agree, which is why DRY works most of the time. But when they disagree, DRY pulls you toward the wrong move.

## The story

We were hardening two SQLite writers in this repo for a many-readers + one-writer concurrency setup: one writes the Y.Doc update log (`yjs/<id>.db`), one writes a queryable projection (`sqlite/<id>.db`). Both needed the same trio of pragmas:

```
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = 5000;
```

Plus the same verification dance: `journal_mode = WAL` doesn't throw on silent fallback, so you have to read the result and warn if it isn't `'wal'`. Plus the same fallback handling for `:memory:`.

So I wrote `applyWriterPragmas(db, log)` in one file and copy-pasted it into the other, swapping `SqliteMaterializerError.PragmaSetupFailed` for `AttachSqlitePersistenceError.PragmaSetupFailed`. About eight lines of difference between the two copies, mostly the error namespace.

Should this be extracted?

DRY says obviously yes, two near-identical bodies. But that isn't the question that matters. The question is: **is there a concept here that must stay singular?**

The answer is yes. The concept is "the standard concurrency pragma setup for our writer-side SQLite files." If we add `wal_autocheckpoint`, both writers need it. If we change the busy timeout from 5s to 10s, both writers need it. If we discover the verification dance has a bug, we fix it once. The two copies aren't accidentally similar. They are two implementations of the same rule, and the rule lives in one place in our heads.

Extract.

## The other story

Earlier in the same review, I noticed `quoteIdentifier` exists in `materializer/sqlite/ddl.ts` and again as a private helper in `client/sqlite-mirror.ts`. Three lines, pure function, identical body:

```ts
function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}
```

DRY says: same code in two files, extract. But ask the source-of-truth question: **if I change one, does the other have to change too?**

No. SQL identifier escaping is an external standard. The function will never need to do anything different on the materializer side versus the mirror side. There is no concept here that lives in our codebase. There's a universal rule that we happen to implement in three lines.

If we extract it, we add a cross-module dependency for a function that will never need synchronized maintenance. The "single source of truth" doesn't live in our code; it lives in the SQL spec. Both copies will agree forever for the same reason `Math.PI` agrees with itself across two files: nobody has to maintain that agreement.

Inline. (Or extract if you want one tidy module of SQL helpers, fine, but don't extract because of DRY.)

## The corollary

Three similar lines is better than a premature abstraction. People say this in the same breath as "DRY is good" without noticing the tension. The reframe resolves it.

Three similar lines that share a source of truth: extract. The lines are downstream of one decision, and that decision needs to live in one place.

Three similar lines that happen to look alike: inline. Each line is downstream of its own decision. Forcing them through a shared abstraction couples decisions that should stay separate, and the day one of them needs to diverge, you fight the abstraction.

The trap is the word "similar." Syntax similarity is the cheap signal you notice first. Semantic singularity is the real signal. Train yourself to look past the first.

## The test

Before extracting, ask the question out loud:

> If I change this body, does the other copy have to change in the same way?

If yes, you've identified one decision pretending to be two. Extract, name the concept, document the rule.

If no, you've identified two decisions that happen to look alike today. Leave them inline. They'll diverge or they won't, and either way the code stays honest.

The bias should be toward inline until the answer is unambiguously yes. Premature extraction is harder to undo than late extraction. A `// TODO: extract once the third caller appears` is a low-cost note. Unwinding a wrong abstraction touches every caller.

## Why DRY misframes

DRY phrases the rule as a prohibition: don't repeat. Repetition is what you see. So you're hunting for visual duplication, and every match you find feels like a finding.

Source of truth phrases the rule as a question: where does this decision live? Decisions are what you maintain. So you're hunting for the maintenance contract, and you only act when you can name it.

The visual hunt is faster but matches false positives. The maintenance hunt is slower but matches the thing that actually causes pain.

The pain isn't repeated code. The pain is two places that drift apart when they were supposed to stay aligned. DRY is a proxy for that pain. Source of truth is the pain itself.

When the proxy and the truth disagree (as they do for things like `quoteIdentifier`, or for three test setups that look the same but test independent decisions, or for two error messages that happen to have the same wording), follow the truth.

## What this changes in practice

Stop reaching for "extract this, it's duplicated." Start reaching for "name the concept these copies are implementing, and decide if it's one concept or two."

If you can name the concept (`applyWriterPragmas`: "our standard pragma setup for writer-side SQLite files in this codebase"), extract. The name is the source of truth, and the extracted function is its implementation.

If you can't name the concept without saying "the same code as that other place" (the only thing the two `quoteIdentifier` copies share), don't extract. There's no concept, just a coincidence.

This is also a hiring signal. An engineer who extracts on sight (DRY) is reading the code. An engineer who extracts after asking the question (source of truth) is reading the system.
