# 0021. Replace Transformations with a Dictionary, an always-on Polish, and a portable Recipe library

- **Status:** Proposed
- **Date:** 2026-06-16 (evolved twice the same day; see Evolution)

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

Delete the `Transformation` concept. Replace it with **three things**, matching
the two behaviors the category (Wispr Flow, VoiceInk, Handy, Apple Writing
Tools, Grammarly) actually has: an always-on, meaning-preserving cleanup, and an
on-demand reshape you pick.

1. **Dictionary** (`dictionary: string[]`): a flat list of words Whispering
   should know, proper nouns and domain terms ("Kubernetes", "Braden"). It is
   not find/replace and not an algorithm. Its terms are **injected into the AI
   prompt** as a runtime-composed block (never a user-managed placeholder), so
   the model spells them right and maps obvious mishearings onto them. Where the
   transcription model accepts an `initial_prompt` (Whisper, OpenAI) the terms
   feed that too; the default Parakeet ignores it harmlessly. This is VoiceInk's
   `<CUSTOM_VOCABULARY>` approach: the AI is the matcher, with world knowledge no
   edit-distance algorithm has.

2. **Polish** (`polish.enabled: boolean` + `polish.instructions: string`): the
   always-on, meaning-preserving AI base. One optional pass that fixes grammar
   and punctuation while keeping the user's wording. On by default, but it only
   runs when an AI key is configured, so a fresh keyless install never pays a
   surprise cost. Turn it off for **speed mode**: the raw transcript ships
   instantly, no AI call. The instruction is editable under Advanced. Polish is
   not a member of the Recipe library; it is the base layer everything else
   stands on.

3. **Recipe** (plural, on-demand): a library of named reshapes, each
   `{ id, name, instructions, icon? }`, text in and text out, knowing nothing
   about voice. Built-in reshapes (Email, Reply, Notes, To-dos) live in code;
   the `recipes` table holds only user-created customs; the picker shows
   `builtins` union `customs`. A Recipe is the portable unit; the host supplies a
   thin source / trigger / delivery adapter. Recipes always run on the
   already-polished text, so reshape composes on top of cleanup for free, no
   second call.

There is no auto-pin and no `pinnedId`. The automatic path is Dictionary plus
Polish; the manual path is Recipes. Auto-versus-manual is which layer you are in,
not a flag on a shared object. The `selectedId` trap is gone by construction: the
only thing that auto-runs is guaranteed meaning-preserving.

### Runtime ordering and delivery

```
transcribe (+ Dictionary terms in initial_prompt where the model supports it)
  -> POLISH               one AI call, only if polish.enabled + key configured;
                          system prompt = polish.instructions + a Dictionary block
                          ("known terms, keep these spellings, map mishearings to them");
                          input = the raw transcript
  -> corrected transcript delivered ONCE to the cursor; raw kept on
                          recordings.transcript ("show original" is one click away)
  -> [picker only] RECIPE one AI call over the polished text; the same Dictionary
                          block is injected; the take lands on clipboard or replaces
                          a selection, never re-typed
```

Delivery is **single-write to the cursor** (deliver-after-polish). While Polish
runs, Whispering shows its own HUD ("Polishing...") to mask the roughly
one-second latency, with an explicit `esc` to cancel the pass and ship the raw
transcript now. Output is not streamed: the category delivers once behind an
overlay, and since the cursor is written once, streaming would only animate a HUD
preview. Speed mode (Polish off) ships the instant raw transcript.

Model and provider come from one global `completion.*` default (ships cloud
`gemini-2.5-flash`), not per-Recipe. The Dictionary block is composed by a pure,
shared `buildSystemPrompt(instructions, dictionary)` helper used by both Polish
and Recipes; the runners read `dictionary` at use (ADR 0012) and pass it in. The
generic `complete()` call stays provider-resolution-only.

The unit stays in Whispering until a second host exists; only then is a shared
package extracted (one consumer is not a seam).

## Evolution

This ADR evolved twice on 2026-06-16.

1. **Transformation to two concepts (Cleanup + Format).** The original split
   separated a "Cleanup" concept (auto AI pass + dictionary) from a "Format"
   library. Waves 1-2 shipped it.

2. **Two concepts to "one AI mechanism" (Dictionary + auto-pinned Recipe).** A
   review collapsed Cleanup into "Dictionary plus a Recipe pinned to auto-run,"
   on the argument that the AI tidy pass is structurally just a Recipe.

3. **Back to three nouns (this decision).** That collapse was over-stated.
   Structural sameness (Polish is "an instruction applied to text," like a
   Recipe) is not conceptual identity. The category has two genuinely different
   behaviors, and forcing them into one list created a `pinnedId` pointer that in
   practice only ever held "Polish" or null: a boolean in a pointer's costume,
   growing toward a future (per-context modes) it does not actually fit. So
   Polish is its own always-on base (a toggle and an instruction), Recipes are
   the on-demand library, and the Dictionary is the third, deterministic-
   knowledge layer. The thing worth deleting was the fusion inside the old
   Transformation (pre/post/prompt/selectedId in one row), not the distinction
   between "always runs" and "you pick it."

The shipped Wave 1-2 code still uses the older `cleanup.*` and `formats` names;
Wave 1 of the build renames them to `polish.*`, `dictionary`, and `recipes`.

## Consequences

- Two behaviors, three nouns, each earning its place: Dictionary (knowledge),
  Polish (always-on base), Recipes (on-demand reshape).
- The Dictionary is injection-only: a `string[]` the runtime composes into every
  AI prompt, plus the transcription `initial_prompt` where supported. No
  find/replace, no regex, no phonetic algorithm to maintain.
- Speed mode (Polish off) is genuinely instant (no AI). Its cost: the Dictionary
  is inactive on Parakeet there (no prompt to inject into). Closing that gap is
  the one job of a future deterministic fuzzy matcher.
- Reshape composes on polished text for free; correction is never duplicated
  across recipes.
- The raw transcript stays on `recordings.transcript`; the cursor is written once
  with the final text, so auto-correction never loses the user's words and never
  double-types.
- Cost: a clean break with no alias layer; a deliberate refusal to auto-run a
  reshaping Recipe; Polish latency masked by a HUD rather than removed.

## Considered alternatives

- **Keep one fused Transformation.** Lost: the cause of duplicated correction
  logic and leaked vocabulary.
- **Two concepts (Cleanup + Format).** Shipped Waves 1-2, then superseded (see
  Evolution).
- **One AI mechanism (auto-pinned Recipe + `pinnedId`).** Rejected: the pointer
  only ever held Polish-or-null, and the real future (per-context modes) is a
  different shape, so the generality grew toward nothing.
- **A deterministic dictionary (literal `heard -> spell`, regex, or fuzzy) in
  v1.** Deferred. With Polish on by default, prompt injection does term
  correction with world knowledge the AI already has (VoiceInk ships exactly
  this). A deterministic fuzzy matcher (Levenshtein + Soundex + n-gram,
  Handy-style) has one unique job, making the Dictionary work in speed mode, and
  carries false-positive risk (Soundex collides Sean/Shawn/Shaun) worth tuning
  behind that wave, not the v1 path. Literal `heard -> spell` is rejected
  outright: it forces users to predict mishearings.
- **Per-Recipe model selection.** Lost: an intimidating knob for a feature most
  users never touch; one global default; additive later.
- **Auto-running a reshaping Recipe (a global pin or mode).** Deferred: the
  correct version is per-context (per-app), not a global default you forget is
  on. A global pin is a worse version of the right feature.
- **Local-default Polish (Apple Intelligence, Ollama).** Deferred: its win is
  free/private/offline/no-key (which would enable on-by-default), not latency.
  Cloud flash and Groq are as fast or faster than an on-device 3B model for a
  short transcript. This is the next big UX wave after v1.
- **Streaming the polish output.** Rejected for v1: the category delivers once
  behind an overlay; we write the cursor once.
- **Extract `@epicenter/recipes` now.** Lost: one consumer is not a seam.

## Open questions

- When does local-default Polish land, and via which provider (Apple
  Intelligence, Ollama, or both)?
- When the fuzzy matcher lands for speed mode, what threshold avoids Soundex
  homophone collisions?
- Does per-context (per-app) recipe selection become "modes," and what is its
  data shape?
