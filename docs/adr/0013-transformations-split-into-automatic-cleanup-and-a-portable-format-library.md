# 0013. Transformations split into an automatic Cleanup layer and a portable Format library

- **Status:** Proposed
- **Date:** 2026-06-16

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

Delete the `Transformation` concept and replace it with two:

1. **Cleanup** (singular, automatic, never picked): makes every transcript
   correct after transcription. Two mechanisms, a deterministic **Dictionary**
   (proper-noun/term spellings; regex and spoken commands are advanced-only) and
   one optional **auto-cleanup** AI tidy pass. Auto-cleanup is on by default only
   when an AI provider/key is already configured; with no key it skips the AI
   pass and delivers dictionary-corrected text (no surprise cost, no broken
   first-run). Cleanup is dictation-specific because it is justified by noisy
   voice input.

2. **Format** (plural, manual, always picked): a library of named instructions,
   each `{ id, name, instructions, icon? }`, run from a picker over selected
   text. A Format is the **portable unit**, text in / text out, knowing nothing
   about voice. The host supplies a thin **source / trigger / delivery** adapter.
   Auto-cleanup is itself "the Format Whispering runs automatically," so a
   non-dictation host (writing app) presents the same Formats on demand with no
   automatic layer.

Formats run on already-corrected text, so correction is written once. The Format
stays dumb (no chaining, steps, variables, per-Format model, or `{{input}}`
template), and model/provider come from one global default. The unit stays in
Whispering until a second host exists; only then is a shared package extracted.

Design detail and migration live in
`/specs/20260616T230000-cleanup-and-portable-formats-greenfield.md`.

## Consequences

- Correction is configured once, never duplicated across output options.
- The Format editor collapses to name + one instruction; model, pre/post,
  prompt-template split, and `showInPicker` are deleted from the surface.
- `transformation.selectedId` is deleted; the automatic path is always Cleanup.
- Post-AI deterministic replacements are dropped (a band-aid for wrong
  ordering); migration surfaces a one-time notice listing what was removed.
- The raw transcript is kept underneath the cleaned one, so auto-cleanup never
  loses the user's original words.
- The picker becomes the natural shared component when a writing app lands; the
  portability is real but unextracted until that second consumer exists.
- Cost: a clean break with no alias layer, and a deliberate refusal of
  auto-running Formats and of any workflow/pipeline composition for now.

## Considered alternatives

- **Keep one fused Transformation object.** Lost: it is the cause of duplicated
  correction logic and leaked vocabulary.
- **One list of actions with an "auto-run" flag.** Lost: reopens the
  `selectedId` conflation; the automatic/manual distinction is worth surfacing.
- **Extract `@epicenter/formats` now.** Lost: one consumer is not a seam;
  premature extraction over keeping the unit dumb and the adapter thin.
- **Per-Format model selection as a normal control.** Lost: intimidating knob
  for a feature most users never touch; additive later if demand appears.
