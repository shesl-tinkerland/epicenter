# 0013. Replace Transformations with a Dictionary, a portable Recipe library, and one auto-pinned Recipe

- **Status:** Proposed
- **Date:** 2026-06-16 (evolved 2026-06-16 post-Wave-2; see Evolution)

## Context

Whispering's `Transformation` fuses two different jobs into one object:
`preReplacements[] -> optional AI prompt -> postReplacements[]`, with one
designated the auto-run via `transformation.selectedId`. Correctness (a property
of every transcript) and reformatting (a choice between alternatives) have
different cardinality and triggers, so fusing them forces every output option to
re-declare correction logic and leaks implementation vocabulary
(pre/post/phase/prompt-template) into the product. The same need recurs outside
dictation: a writing app wants to run the same saved actions over a selection.

## Decision

Delete the `Transformation` concept. Replace it with **one deterministic
Dictionary** plus **one portable library of Recipes**, of which **one is pinned
to run automatically**:

1. **Dictionary** (deterministic, instant, always-on, dictation-specific): the
   one thing AI cannot reliably get right, proper-noun and domain-term spellings
   ("brayden" -> "Braden", "k8s" -> "Kubernetes"). It is not AI and not a
   Recipe; it is its own layer. It runs once, on the raw transcript, before any
   AI. Its target terms are also injected into the auto-pinned Recipe's prompt so
   the AI cannot un-fix them (see Runtime ordering). The strong form is a
   single-column, fuzzy matcher (you list the correct word; phonetic + edit
   distance snap mishearings to it, Handy-style); exact `heard -> spell` and
   spoken-command mappings ("new line") are an advanced override. Regex stays
   advanced-only.

2. **Recipe** (plural, manual, portable): a library of named instructions, each
   `{ id, name, instructions, icon? }`, text in / text out, knowing nothing
   about voice. The portable unit. The host supplies a thin
   **source / trigger / delivery** adapter. (This is the unit previously called
   "Format".)

3. **The auto-pinned Recipe** is what makes every transcript correct without a
   choice. It is **not a separate kind of object**: it is simply the Recipe
   Whispering designates to run automatically after transcription, gated so it
   fires only when an AI provider/key is already configured (no surprise cost, no
   broken first-run). It defaults to a meaning-preserving "Polish" Recipe ("Fix
   grammar and punctuation, keep my wording"). The picker shows the *other*
   Recipes, run on demand over already-corrected text.

The thing previously called "Cleanup" therefore dissolves into **Dictionary +
the auto-pinned Recipe**. There is exactly one AI mechanism (a Recipe); the
automatic/manual distinction is a *property* (which Recipe is pinned), not a
second object type.

### Runtime ordering and delivery

```
transcribe
  -> DICTIONARY            deterministic, fuzzy, once, on the raw transcript
  -> AUTO-PINNED RECIPE    one AI call, only if pinned + key configured;
                           the Dictionary's terms are injected into its prompt
                           as "preserve these spellings" so the AI never un-fixes them
  -> corrected transcript  delivered ONCE to the cursor (the cursor is never
                           written twice); raw kept on recordings.transcript
  -> [picker only] RECIPE  one AI call over the corrected transcript; the take
                           lands on clipboard / replaces a selection, never re-typed
```

No deterministic replacement runs *after* the AI. The "AI un-fixes a name"
failure mode is handled by prompt injection, not a post-pass (a blind post-pass
corrupts prose, e.g. a "new line" mapping inside "a new line of work").

Delivery is **single-write to the cursor** (deliver-after-correction). Instant
feedback and the streaming polish live in Whispering's own HUD (a surface it may
mutate), with an explicit "ship raw now" escape while polishing. Pure speed is a
settings choice: turn the auto-pin off and the instant, final Dictionary-only
output is what ships.

Model/provider come from one global `completion.*` default, not per-Recipe. The
unit stays in Whispering until a second host exists; only then is a shared
package extracted.

## Evolution

This ADR originally split `Transformation` into a two-concept model: a separate
"Cleanup" concept (auto-cleanup AI pass + dictionary) and a "Format" library.
Wave 1 + Wave 2 shipped that. Reviewing it against the user story and against
Handy's design surfaced two collapses, recorded above:

- **Cleanup was not a second concept.** Its AI pass needs no primitive a Recipe
  lacks; it is a Recipe pinned to auto-run. The only genuinely separate
  primitive is the deterministic Dictionary. Collapsing to "Dictionary +
  auto-pinned Recipe" removes a whole mental model. The original objection (a
  pinned auto-run reopens the `selectedId` conflation) is dissolved because the
  universal-correction part now lives in the Dictionary, outside the Recipes.
- **"Format" became "Recipe"**, which reads as "a saved reusable rewrite" rather
  than "styling."

The `cleanup.*` / `formats` KV and table names from Wave 1 will follow the
vocabulary (`dictionary`, `recipes`, an auto-pin pointer) in a later wave; the
shipped code still uses the older names.

## Consequences

- Correction is configured once (the Dictionary), never duplicated across output
  options, and is protected through the polish prompt rather than a post-pass.
- One AI concept (Recipe). The editor collapses to name + one instruction; model,
  pre/post, prompt-template split, and `showInPicker` are gone.
- `transformation.selectedId` is deleted; the automatic path is the auto-pinned
  Recipe, defaulting to Polish.
- The raw transcript is kept on `recordings.transcript`; the cursor is written
  once with the final text, so auto-correction never loses the user's words and
  never double-types.
- The picker is the natural shared component when a writing app lands; the
  portability is real but unextracted until that second consumer exists.
- Cost: a clean break with no alias layer, a deliberate refusal of post-AI
  replacements and of auto-running a *reshaping* Recipe by default, and a fuzzy
  Dictionary matcher to build (more than a literal find/replace).

## Considered alternatives

- **Keep one fused Transformation object.** Lost: the cause of duplicated
  correction logic and leaked vocabulary.
- **Two concepts (separate "Cleanup" + "Format").** Shipped in Wave 1-2, then
  collapsed: the auto AI pass is a pinned Recipe, so the second concept did not
  earn its place (see Evolution).
- **Post-AI deterministic replacements (the old `postReplacements`).** Lost:
  recovered from `transform.ts` (pre -> prompt -> post), it is a band-aid for
  wrong ordering. Handy independently corrects vocab pre-LLM only. The real
  failure mode (the AI un-fixing a term) is solved by injecting terms into the
  polish prompt, which a blind post-pass would instead corrupt.
- **Literal `heard -> spell` dictionary only.** Lost as the headline: it forces
  users to predict mishearings. A single-column fuzzy matcher (Levenshtein +
  Soundex + n-gram, Handy-style) is the better product; literal/regex stay as
  advanced overrides.
- **Per-Recipe model selection.** Lost: an intimidating knob for a feature most
  users never touch; additive later.
- **Extract `@epicenter/recipes` now.** Lost: one consumer is not a seam.

## Open questions

- Does the auto-pin default to a meaning-preserving Polish only, or may a user
  pin a *reshaping* Recipe (e.g. Email) and accept the "I forgot it was on"
  surprise? (Leaning: allow it, but make the pinned Recipe visible and
  per-dictation overridable.)
- Is the fuzzy single-column Dictionary worth its algorithmic cost over the
  shipped literal `heard -> spell`, and when does it land?
