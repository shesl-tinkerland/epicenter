# Dictation rewrite: Polish, Dictionary, and a portable Recipe library

**Date**: 2026-06-16 (relocked after a design pass; see ADR 0013 Evolution)
**Status**: In Progress (Waves 1-2 of the old two-concept model landed; this is
the relocked build plan, greenfield, compatibility released, no migration)
**Owner**: Braden
**Branch**: `whispering-cleanup-formats-restart`
**ADR**: [0013](/docs/adr/0013-transformations-split-into-automatic-cleanup-and-a-portable-format-library.md)
(read it first; it carries the why and the rejected alternatives)

## The locked model

Three nouns, two behaviors. ADR 0013 has the reasoning; this is the shape to
build.

- **Dictionary** (`dictionary: string[]`): words Whispering should know.
  Injection-only: a runtime-composed block in every AI prompt, plus the
  transcription `initial_prompt` where the model supports it. No find/replace, no
  regex, no algorithm in v1.
- **Polish** (`polish.enabled: boolean` + `polish.instructions: string`): the
  always-on, meaning-preserving AI base. On by default, gated on a configured
  key. Off = speed mode (instant raw transcript, no AI). Instruction editable
  under Advanced. Not a Recipe.
- **Recipes**: the on-demand reshape library. Built-ins in code (Email, Reply,
  Notes, To-dos); `recipes` table holds customs; picker shows `builtins` union
  `customs`. Each runs on already-polished text.

No `pinnedId`, no auto-pin, no deterministic dictionary, no streaming. Model and
provider come from one global `completion.*` default.

### Runtime flow

```
transcribe (Dictionary terms in initial_prompt where supported)
  -> runPolish: if polish.enabled && key configured && input non-empty,
       one AI call; systemPrompt = buildSystemPrompt(polish.instructions, dictionary);
       else pass the raw transcript through unchanged (speed mode)
  -> deliver the polished text ONCE to the cursor; raw stays on recordings.transcript
       (HUD shows "Polishing..." during the call; esc cancels and ships raw)
  -> [picker only] runRecipe over the polished text;
       systemPrompt = buildSystemPrompt(recipe.instructions, dictionary)
```

`buildSystemPrompt(instructions, dictionary)` is pure (no settings access): it
returns `instructions` plus a tagged term block when the dictionary is non-empty,
and `instructions` alone when it is empty. The runners read `dictionary` at use
and pass it in. `complete()` stays provider-resolution-only. This is the one unit
worth a test.

## What is on disk today (Waves 1-2, the old two-concept model)

Already shipped and green, to be renamed in Wave 1:

- KV: `cleanup.autoCleanup` (a `{ enabled, instructions } | { enabled: false }`
  union), `cleanup.dictionary` (`DictionaryEntry[]` with `heard`/`spell`/`regex`/
  `wholeWord`), `completion.provider`, `completion.model`,
  `output.transcription.*`, `output.format.*`, `sound.formatComplete`,
  `shortcut.openTransformationPicker`, `shortcut.runTransformationOnClipboard`.
- Table: `formats` (`Format = { id, name, instructions, icon }`).
- Ops: `run-cleanup.ts` (`runCleanup` with `applyDictionary` find/replace + AI
  pass), `run-format.ts` (`run({ input, format })`), `completion.ts` (`complete`,
  `hasCompletionKey`), `pipeline.ts` (transcribe -> runCleanup -> deliver),
  `delivery.ts` (`deliverTranscriptionResult`, `deliverFormatResult`).
- State: `state/formats.svelte.ts` (`formats`, `generateDefaultFormat`).
- Stubs: `operations/transformation-picker.ts`,
  `operations/transformation-clipboard.ts` (report "coming soon").
- No settings UI exists for any of this yet (the old transformations route was
  deleted).

## Build waves

### Wave 1: data model + runtime reshape (backend only, stays green, the tracer) — LANDED

> **Landed** (2 commits): 1.1 renamed the Format library to Recipes; 1.2-1.3
> replaced Cleanup with `polish.enabled`/`polish.instructions` + `dictionary:
> string[]`, added the pure `buildSystemPrompt` (with a unit test), rewired
> `runPolish`/`runRecipe`/the pipeline through it, deleted the find/replace path,
> and renamed the command stubs + shortcut keys to `openRecipePicker` /
> `runRecipeOnClipboard`. Clean typecheck, 21 tests pass. The legacy Dexie
> `transformations`/`transformationRuns` IndexedDB schema is intentionally left
> alone (audio blob store version history, a name collision, not this feature).

Polish starts working end-to-end for anyone with a key, on the existing
toast-based delivery. Suggested as ~3 commits.

1. **Rename `formats` -> `recipes`.** Table key `formats` -> `recipes`;
   `Format` -> `Recipe`; `state/formats.svelte.ts` -> `state/recipes.svelte.ts`
   (`formats` -> `recipes`, `generateDefaultFormat` -> `generateDefaultRecipe`);
   `run-format.ts` -> `run-recipe.ts` (`run` -> `runRecipe`); `output.format.*`
   -> `output.recipe.*`; `sound.formatComplete` -> `sound.recipeComplete`;
   `deliverFormatResult` -> `deliverRecipeResult`; update the debug page's
   `tables.formats.storedCount()` and any `workspace/index.ts` exports.
2. **Reshape `cleanup.*` -> `polish.*` + `dictionary`.** Replace
   `cleanup.autoCleanup` (union) with two KV keys `polish.enabled: boolean`
   (default `true`) and `polish.instructions: string` (default
   "Fix grammar and punctuation. Keep my wording."). Replace `cleanup.dictionary`
   with `dictionary: string[]` (default `[]`). Delete the `AutoCleanup` and
   `DictionaryEntry` typebox schemas + exported types.
3. **Rewire the runners.** Add `buildSystemPrompt(instructions, dictionary)`
   (pure; its own file or in `completion.ts`). `run-cleanup.ts` ->
   `run-polish.ts`: `runPolish({ input })` reads `polish.*` + `dictionary` at
   use, runs one completion through `buildSystemPrompt` when enabled + keyed +
   non-empty, else returns the input unchanged. Delete `applyDictionary`,
   `escapeRegExp`, and the whole find/replace path. `runRecipe` uses
   `buildSystemPrompt`. `pipeline.ts`: `runCleanup` -> `runPolish` (delivery and
   the "keep raw underneath" behavior are unchanged). Rename the two command
   stubs + their `shortcut.*` keys to `openRecipePicker` /
   `runRecipeOnClipboard`.

Keep the auto-cleanup-failure-is-non-fatal behavior (a failed Polish pass
surfaces a notice and still delivers the un-polished transcript via the error's
`fallback`).

Verify: `cd apps/whispering && bun run check && bun test`, then grep that no
`cleanup`, `transformation`, `Format` (the type), `DictionaryEntry`,
`applyDictionary`, or `autoCleanup` references survive.

### Wave 2: Dictation settings UI — LANDED

> **Landed**: new `settings/dictation/+page.svelte` (added to the settings
> SidebarNav after Transcription). Polish toggle via `SettingSwitch`
> (`polish.enabled`), the instruction (`polish.instructions`) under a
> `Collapsible` "Advanced" disclosure shown only when Polish is on, and the
> Dictionary as an add/remove term list (dedupe + blank-skip) over
> `dictionary`. Pure UI over Wave 1 data through the `settings` namespace.

A Settings -> Dictation page: a Polish toggle (off = speed mode) with the
instruction editable under an Advanced disclosure, and a Dictionary as an
add/remove list of plain strings. This is the only way to reach speed mode or add
known terms in-app. Pure UI over Wave 1's data; read/write through the `settings`
namespace.

### Wave 3: HUD overlay + esc-to-ship-raw

A Whispering-owned "Polishing..." surface shown while the Polish pass runs, with
`esc` to cancel the in-flight completion (AbortController threaded through
`complete`) and deliver the raw transcript immediately. Single-write delivery is
already in place from Wave 1; this makes the wait legible. Heaviest UI wave: it
needs an overlay surface and completion cancellation. No streaming.

### Wave 4: Recipes picker + library + built-ins

Built-in reshapes in code (Email, Reply, Notes, To-dos; no "Clean", Polish covers
it). A Recipes library page listing `builtins` union `customs` with a sticky-note
editor (name + one instruction + optional icon). Rebuild the picker over the
library (source = transcript/clipboard/selection; runner = `runRecipe`) and
repoint `openRecipePicker` / `runRecipeOnClipboard` at it, reusing the existing
shortcut wiring.

### Wave 5 (small, optional): transcription `initial_prompt` injection

Append the Dictionary terms to `transcription.prompt` for models that accept one
(Whisper, OpenAI); Parakeet ignores it. Small, additive, touches `transcribe.ts`
and the relevant transcription services.

## Deferred, not v1 (recorded in ADR 0013 with reasons)

- A deterministic fuzzy matcher (Levenshtein + Soundex + n-gram) whose one job is
  making the Dictionary work in speed mode.
- Local-default Polish (Apple Intelligence, Ollama) for zero-setup,
  privacy, offline, and on-by-default.
- Per-context (per-app) recipe selection ("modes").

## Refusals (for now)

- Auto-running a reshaping Recipe; a `pinnedId`; post-AI deterministic
  replacements; per-Recipe model selection; `{{input}}` or `{{dictionary}}`
  placeholders; `showInPicker`; streaming; chaining or multi-step Recipes;
  extracting a shared package before the second host exists.
