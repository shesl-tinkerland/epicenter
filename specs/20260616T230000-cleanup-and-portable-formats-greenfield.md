# Cleanup and Portable Formats: Replace Transformations with an Automatic Correction Layer and a Reusable Text-Action Library

**Date**: 2026-06-16
**Status**: In Progress (Waves 1-2 landed; greenfield, compatibility with the current transformation model explicitly released)
**Owner**: Braden
**Branch**: `whispering-cleanup-formats-restart`
**ADR**: [0013](/docs/adr/0013-transformations-split-into-automatic-cleanup-and-a-portable-format-library.md)

## At a glance

**Current state (origin/main).** Whispering ships the fused `Transformation`
model: a `transformations` table whose rows are
`preReplacements[] -> optional AI prompt -> postReplacements[]`, a
`transformationRuns` history table, and a `transformation.selectedId` KV that
designates one transformation as the post-transcription auto-run. The runner is
`operations/transform.ts` (pre/prompt/post phases); `operations/pipeline.ts`
auto-runs `selectedId` after each transcription; an editor
(`components/transformations-editor/*`), a `TransformationSelector`, a Tauri
picker window (`routes/transformation-picker/*`), and recordings row-actions
sit on top. The shape leaks implementation vocabulary (pre/post/phase/
prompt-template) into the product and forces every output option to re-declare
its own correction logic.

**Target shape.** Delete "Transformation" and split it into two concepts with
different cardinality and triggers:
- **Cleanup** (singular, automatic, never picked): a `cleanup.dictionary` of
  deterministic spelling fixes plus one optional `cleanup.autoCleanup` AI tidy
  pass. Lives in settings. Makes every transcript correct.
- **Format** (plural, manual, always picked): a `formats` table of named
  text-in/text-out instructions, run on demand through one shared picker. The
  portable unit; knows nothing about voice.
Model/provider come from one global `completion.*` default, not from the unit.
The raw transcript stays on `recordings.transcript` underneath the cleaned text.

**Implementation waves.**
- **Wave 1 (this branch, landed): data model + runner reshape.** Add Cleanup
  settings + `completion.*` default + `formats` table; add the source-agnostic
  `run({ input, format })` runner; delete the `transformations`/
  `transformationRuns` tables, `transformation.selectedId`, the pre/prompt/post
  types, the old runner, and the now-uncompilable editor/selector/picker/route
  UI. The two shortcut commands become Wave-3 stubs so shortcut wiring stays
  compiling. No compatibility layer.
- **Wave 2 (landed): automatic path.** Post-transcription runs Cleanup
  (dictionary -> auto-cleanup); deliver cleaned text, keep raw underneath.
- **Wave 3: manual path + picker.** Formats library page + sticky-note editor;
  repoint the picker/clipboard commands at Formats; ship default Formats.
- **Wave 4: data migration.** Migrate existing transformation rows per the
  rules below, with a one-time notice for anything dropped.

**Verification (per wave).** `cd apps/whispering && bun run check && bun test`,
plus a stale-reference grep for `transformation.selectedId`,
`TransformationSelector`, `transformationRuns`, `runTransformation`, and the
`transformations` table. Wave 1's bar: a clean typecheck with the
Transformation model fully deleted and only the two intentional Wave-3 command
stubs remaining (marked `TODO(wave-3)`).

## Current main context (what this reshape sits on)

This spec is written against current `origin/main`, which has moved since the
2026-06-12 transformation specs. Reflect these when building later waves:

- **ADR 0011 (Rust owns the macOS dictation capability)** and **ADR 0012
  (transcription settings are read at use, not mirrored into Rust)**: the
  read-at-use discipline applies to Cleanup too. The Wave-2 auto path and the
  Wave-3 runner read `completion.*` / `cleanup.*` from `settings` at call time;
  do not mirror them into Rust or cache them.
- **Settings projection.** `workspace/definition.ts` now owns the KV map behind
  a `settings` namespace (`settings.keys`, `settings.getDefault`,
  `settings.reset`); callers never see raw `defineKv`. Cleanup/Format/completion
  keys are added there and reach the app through that namespace, not a parallel
  store.
- **Shortcut / platform seams.** In-app shortcuts are workspace KV
  (`shortcut.*`); global shortcuts are per-device (`deviceConfig`,
  `shortcuts.global.*`); commands converge through `commands.ts` +
  `dispatchCommandTrigger`, with desktop-only commands behind
  `#platform/commands` (`commands.tauri.ts`). Wave 1 keeps the
  `openTransformationPicker` / `runTransformationOnClipboard` command IDs and
  their bindings wired; Wave 3 repoints their bodies at the Format picker rather
  than re-plumbing the shortcut layer.
- **`recordings.transcript`** already stores the raw transcriber output, so
  "keep the raw underneath the cleaned text" needs no new column.

> Supersedes the current `Transformation` model
> (`preReplacements[] -> prompt? -> postReplacements[]`) and the related runtime.
> Builds on the boundary insight in
> `/specs/20260612T110000-whispering-pipelines-workspace-boundary.md` (the
> "select-text-anywhere picker as the engine's second consumer" vision) and
> takes it greenfield: the second consumer is no longer hypothetical, it is the
> reason for the reshape.
>
> Two inherited concerns from the 2026-06-12 specs, carried but not resolved here:
> - **Sync/library boundary** (`/specs/20260612T110000-...-workspace-boundary.md`):
>   definitions as a shareable library, runs as app-side history. Orthogonal to
>   this concept reshape; revisit when sync ships, with the library holding
>   Formats + Cleanup instead of transformations.
> - **Custom backends** (`/specs/20260612T091000-whispering-custom-backend-profiles.md`):
>   named Ollama/LM Studio endpoints survive, but per the global-default decision
>   here they bind to the global AI default, not to a per-Format slot.

## One Sentence

Delete "Transformation" and split it into two concepts with different jobs: a
singular automatic **Cleanup** that makes every transcript correct, and a
plural on-demand library of **Formats** (named text-in/text-out instructions)
that any app, starting with Whispering and reaching toward a writing app, can
run over a selection through one shared picker.

## How to read this spec

```txt
Read first:        At a glance, One Sentence, Why the old model is wrong, The two concepts
Read for the API:  Data model, Runtime flow
Read for the UX:   UI structure, Default Formats, The shared popup
Read to build it:  Migration, Sequencing, Refusals
Read for the why:  Vision (portable text actions)
```

## Why the old model is wrong

A `Transformation` today is `preReplacements[] -> optional AI prompt ->
postReplacements[]`, stored one-per-row, and one of them is designated the
auto-run via `transformation.selectedId`. This fuses two genuinely different
jobs into one object:

- **Correctness** is a property of *every* transcript. It should be singular,
  automatic, and never chosen.
- **Reformatting** is a choice between *alternatives*. It should be plural,
  manual, and always chosen.

Fusing them is the disease. It forces the same correction logic (filler
removal, name fixes, punctuation) to be re-declared inside every output option,
or silently missing from it. It makes "polished email" carry find/replace
plumbing it should not care about. And it leaks implementation vocabulary
(pre/post/phase/prompt-template) into the product surface.

The greenfield fix is not a better transformation editor. It is deleting the
"transformation" concept.

## The two concepts

### Cleanup (singular, automatic, never picked)

How Whispering makes every transcript correct. Runs on its own after each
transcription. Two mechanisms:

- **Auto-cleanup**: one AI tidy pass. A toggle, **on by default only when an AI
  provider/key is already configured**; with no key it silently skips the AI
  pass and delivers dictionary-corrected text (no surprise cost, no broken
  first-run, magic once a key exists). The median user never touches the toggle.
  Its instruction ("Fix grammar and punctuation, keep my wording.") is editable
  under advanced only.
- **Dictionary**: deterministic spelling fixes for the one thing AI cannot
  reliably get right, proper nouns and domain terms ("brayden" -> "Braden",
  "k8s" -> "Kubernetes"). Most users add a couple of rows and forget it exists.
  Regex and spoken-command mappings ("new line") live behind an advanced
  disclosure, not the headline.

Cleanup is dictation-specific. It is automatic *because voice input is noisy*.
That justification does not transfer to apps where the user is already typing
correct text.

### Formats (plural, manual, always picked)

A library of named instructions. Each is one sentence ("Rewrite this as a
polished, friendly email."). You trigger Formats from a picker and choose one
result. Entirely opt-in. The library ships pre-populated with good defaults so
the user gets value with zero configuration.

A Format is the **portable unit**. It knows nothing about voice. It is just
text in, text out.

## The portable unit and the host seam

Strip a Format down and it is host-agnostic. What differs between apps is only
the three things *around* it:

```
PORTABLE (the "what")          PER-HOST (the "where/how")
─────────────────────          ──────────────────────────
Format = name + instruction    source   (transcript | selection | clipboard)
Dictionary (deterministic)     trigger  (auto | shortcut | popup on selection)
the runner (text -> text)      delivery (copy | paste | replace selection | pick-a-take)
```

This is the established category shape (Raycast AI Commands, Grammarly, Apple
Writing Tools): a saved action library that runs over whatever text the host
hands it. The action library is shared; the host supplies source and delivery.

Cleanup is not a different kind of object. **It is a trigger choice.**
Auto-cleanup is "the tidy Format Whispering runs automatically." In a writing
app, where you type correct text, nothing runs automatically, so "Fix grammar"
simply appears in the popup as one action among the Formats, exactly like
Apple's "Proofread."

### Discipline that keeps this from becoming a workflow builder

The Format stays dumb: name + one instruction, text in, text out. **No
chaining, no variables, no per-Format model, no conditionals, no steps.** The
host is opinionated; the unit is tiny. That is how you get reuse without
building Zapier. (See Refusals.)

## Data model

```ts
// Settings — the automatic path. Singular, never "picked".
type Cleanup = {
  autoCleanup:
    | { enabled: true; instructions: string }   // instructions editable, advanced
    | { enabled: false };                         // default ships enabled
  dictionary: DictionaryEntry[];
};

type DictionaryEntry = {
  heard: string;          // what the transcriber produced
  spell: string;          // what to write instead ("" removes the match)
  regex?: boolean;        // advanced; default literal
  wholeWord?: boolean;    // advanced
};

// Yjs table — the manual path. Plural, picked.
type Format = {
  id: string;
  name: string;
  instructions: string;   // the single prompt. No system/user split, no {{input}}.
  icon?: string;          // optional, auto-assigned default; never blocks creation
};

// Settings — the single global AI default (Settings -> AI). One place, no per-Format slot.
type Completion = {
  provider: InferenceProviderId;  // ships "Google"
  model: string;                  // ships "gemini-2.5-flash"
};
```

What is deliberately absent from `Format`, versus today:

- no `preReplacements` / `postReplacements` (correction is Cleanup's job, run once)
- no `systemPromptTemplate` + `userPromptTemplate` split (one `instructions`)
- no `{{input}}` placeholder (input is implicitly the corrected text)
- no per-Format `inferenceProvider` / `model` (one global default; advanced
  override is a later, purely additive change, refused for v1)
- no `showInPicker` flag (if you made a Format you want it; delete it otherwise)

Model and provider come from a single global AI default (Settings -> AI,
`completion.provider` / `completion.model`), not from the unit. This was an
explicit decision: per-object model selection is the kind of power-knob that
makes the editor look intimidating for a feature 95% of users will not touch,
and it is additive later if real demand appears. API keys and endpoints stay in
`deviceConfig` (local, never synced); only the provider/model selection roams.

## Runtime flow

```
transcribe
  -> CLEANUP                       (the only thing on the automatic path)
       dictionary (deterministic, ordered)
       auto-cleanup (one AI call, if enabled)
  -> corrected transcript          stored + delivered automatically
                                   (raw transcript kept underneath, recoverable)
  -> [picker only] FORMAT
       one AI call, input = corrected transcript, instructions = format.instructions
  -> candidate take(s) -> user accepts one -> delivered
```

Two layers, fixed order. Cleanup always; then at most one Format, only when
picked. Formats always run on already-corrected text, so correction is written
once and never duplicated.

**Trust note**: auto-cleanup lets a model silently rewrite the user's words.
For dictation that is usually the job, but it can change meaning. Keep the raw
transcript stored underneath (the recording already holds it on
`recordings.transcript`) and deliver the cleaned version, so "show original" is
always one click away. This is the one place worth spending a little complexity.

The runner signature is source-agnostic: `run({ input: string, format })` takes
arbitrary text and returns a single take. It performs no workspace writes, no
persistence, and no toasts; the picker (Wave 3) owns delivery and any history
bookkeeping. `recordingId`, where used at all, becomes a write-only bookkeeping
tag on history, nullable, never load-bearing.

## UI structure

### Whispering: where users access each concept

```
Settings -> Dictation
  Auto-cleanup     ( • ) on        "Fix grammar, keep my wording"   [edit]
  Dictionary       brayden -> Braden,  k8s -> Kubernetes            [+ add]

Formats   (top-level page, also opens from the picker)
  ✉️ Email   💬 Reply   📝 Notes   ☑️ To-dos   ✨ Clean      (ship as defaults)
  + New format
```

The two homes match the two triggers: Cleanup is configured once in settings (a
toggle + a dictionary); Formats are an open-ended library you add to freely.

### The Format editor is a sticky note

```
New format
──────────
Name      [ Polished email                         ]   Icon [✉️]
Do this   [ Rewrite this as a polished, friendly email. ]
Show in picker is gone. Model is gone. Pre/post is gone.
[ Try it ▸ ]
```

### The shared popup (same component across hosts)

Whispering, source = transcript, fired by shortcut:

```
"i'll get back to you tomorrow re the q3 numbers"        (already corrected)
─────────────────────────────────────────────────
type to filter…                          ⏎ run · esc
 1 ✉️ Email      4 ☑️ To-dos
 2 💬 Reply      5 ✨ Clean
 3 📝 Notes
─────────────────────────────────────────────────
1 ✉️  Hi, I'll follow up tomorrow with the Q3 numbers. Thanks!
2 💬  Will get you the Q3 numbers tomorrow.
                                  ↑↓ choose · ⏎ copy
```

A writing app, source = CodeMirror selection, fired on highlight:

```
            ┌───────────────────────────────┐
… text text │ Ask…                          │ text …
            │ ✨ Fix grammar                 │
            │ ✉️ Email   💬 Reply   📝 Notes  │
            ├───────────────────────────────┤
            │ Will get you the Q3 numbers…  │
            │ [Replace]  [Copy]  [Insert ↓] │
            └───────────────────────────────┘
```

Same Format list, same runner. Only source (selection vs transcript) and
delivery (Replace selection vs Copy) differ. In the writing app the cleanup
"Fix grammar" action just appears inline as one more entry, because there is no
automatic trigger to hide it behind.

## Default Formats (ship-with)

The most important "not overwhelming" move, straight from Apple and Grammarly:
the library is never empty. Ship opinionated defaults so the user gets value
with zero configuration and only writes a custom Format when the defaults miss:

- **Clean** — a faithful, tidied transcript (the no-restyle option)
- **Email** — polished, friendly email
- **Reply** — concise reply
- **Notes** — meeting notes
- **To-dos** — action items as a checklist

Curated defaults do roughly 90% of the work; custom Formats are the escape
hatch. That is the answer to "give them control but not too open."

## Vision: portable text actions

The reason to build it this way is that the unit lifts cleanly into other apps:

- **Whispering** runs Formats automatically (Cleanup) and on demand (picker over
  a transcript or clipboard).
- A **writing app** (a CodeMirror-backed editor) runs the *same saved Formats*
  on a highlighted selection through the *same popup*, Grammarly/Raycast style.
  No automatic layer; everything is on-demand.
- Anything else with text (a notes view, a chat composer) becomes a host by
  supplying source + delivery.

The writing-app case is the proof the split is right: if Cleanup and Formats
were one fused "Transformation," none of this would lift. Because the unit is
small and source-agnostic, it does.

**Do not extract a shared package yet.** Per our own rule (one consumer is not a
seam), the Format library, Dictionary, and runner live in Whispering until the
writing app actually exists. What makes them portable is keeping the Format dumb
and the host adapter thin (`source` / `trigger` / `delivery`), not a premature
`@epicenter/formats` package. The day the second host lands, lifting the unit
out is mechanical, and the popup is the natural shared component.

## Migration from the pre/prompt/post model

Compatibility is released; this is a clean break, not an alias layer. Wave 1
deletes the old tables outright (pre-release, no deployed data to preserve);
this section governs Wave 4, when a real migration of existing rows is wanted.

1. **The transformation in `transformation.selectedId`** (the current auto-run):
   - its replacements seed `Cleanup.dictionary` (merge pre + post into one
     ordered list; literal entries become dictionary rows, regex entries become
     advanced regex rows);
   - if its prompt is a light grammar/punctuation fix, it becomes
     `Cleanup.autoCleanup.instructions`; otherwise it becomes a Format.
2. **Every other transformation** becomes a **Format**:
   `systemPromptTemplate` + `userPromptTemplate` concatenate into `instructions`,
   `{{input}}` is stripped, the name carries over, an icon is auto-assigned.
3. **`postReplacements`** on non-selected transformations are **dropped**.
   Surface a one-time notice listing exactly what was dropped so it is not
   silent (post-AI find/replace was a band-aid for wrong ordering; see
   Refusals).
4. **`transformation.selectedId`** is deleted. The automatic path is always
   Cleanup; there is nothing to select.
5. **`TransformationRun` history**: keep read-only under a renamed "Recent takes"
   view, or drop. Low value either way; not load-bearing. Decide during build.

## Sequencing

```
Wave 1  Data model + runner reshape          [LANDED on whispering-cleanup-formats-restart]
        - add Cleanup (settings) + completion.* default + Format (table)
        - delete transformations + transformationRuns tables, transformation.selectedId,
          Replacement / TransformationPrompt / Transformation / TransformationRun types,
          the old runner, editor, selector, picker window, and recordings run UI
        - runner takes { input, format }; no pre/post, no {{input}}, no per-Format model
        - keep raw transcript stored underneath (recordings.transcript)
        - keep the two shortcut commands as Wave-3 stubs so shortcut wiring compiles
Wave 2  Automatic path                          [LANDED on whispering-cleanup-formats-restart]
        - post-transcription runs Cleanup (dictionary -> auto-cleanup)
        - deliver cleaned text, keep raw underneath; read completion.*/cleanup.* at use
        - shared completion call path (operations/completion.ts: complete + hasCompletionKey)
          extracted so the Cleanup and Format runners do not duplicate provider resolution
        - retired the dead transformation output vocabulary early (see decision below)
Wave 3  Manual path + picker
        - Formats library page + sticky-note editor
        - repoint the openTransformationPicker / runTransformationOnClipboard commands at Formats
          (source = transcript/clipboard), reusing the existing shortcut wiring
        - ship default Formats
Wave 4  Migration + cleanup
        - migrate existing transformations per the rules above, one-time notice
        - (the output.transformation.* / sound.transformationComplete naming was already
          retired in Wave 2; see the decisions below)
Later   Writing-app host (separate consumer; triggers package extraction)
```

### Wave 2 decisions

- **Delivery ordering: deliver-after-cleanup.** The pipeline holds delivery
  until Cleanup finishes and delivers the cleaned text once, through the
  existing `output.transcription.*` preferences. Cleanup is invisible inline
  correction, not a separately-routed stage, so it needs no output scope of its
  own. The rejected alternative (deliver raw immediately, then replace at the
  cursor) re-opens the double-type problem the transcription/format cursor
  asymmetry exists to dodge. The raw transcript stays on `recordings.transcript`
  (written by `transcribeAndPersist`), so no new column is needed.
- **Renamed the dead transformation vocabulary to `format`, not `cleanup`.**
  Wave 1 left `output.transformation.*`, `sound.transformationComplete`, and
  `deliverTransformationResult` dead at runtime. Because the automatic path
  rides `output.transcription.*` (above), this scope's real successor is the
  Wave-3 Format picker, so the honest rename is `output.format.*` /
  `sound.formatComplete` / `deliverFormatResult`. Renaming to `cleanup.*` would
  have described a delivery, sound, and output scope Cleanup does not own.
- **Auto-cleanup failure is non-fatal.** A failed AI tidy pass surfaces a
  non-blocking notice and still delivers the dictionary-corrected text (carried
  in the error's `fallback`), so a transcript is never lost to a tidy-pass error.

## Refusals (explicit, for now)

- **Auto-running a Format.** The automatic path is Cleanup only. Refused so the
  automatic/manual distinction stays honest. Revisit if users keep asking for an
  "always email" mode; then add an opt-in auto-Format, still separate from
  Cleanup.
- **Chaining Formats / multi-step AI / branching / variables / reusable
  sub-steps.** None serve "correct my dictation" or "give me alternatives
  fast." They turn an opinionated dictation tool into a workflow builder.
- **Post-AI deterministic replacements.** Every real case is either a prompt
  failure (fix the instruction) or impossible (correction already ran first).
- **Per-Format model/provider selection.** One global default; override is
  additive later.
- **`showInPicker` and required icons.** Flags and config that exist only to
  undo or decorate the thing you just made.
- **Prompt templates with placeholders beyond the implicit transcript.**
- **Extracting `@epicenter/formats` before the second host exists.**

## Revisit triggers

- Users repeatedly ask to pin a Format as automatic -> opt-in auto-Format.
- A real (not hypothetical) need to feed one Format's output into another ->
  consider exactly one extra layer, never a generic builder.
- Dictionary grows into "work vs personal" sets -> promote Cleanup from singular
  to a small named set with one active.
- Format instructions start needing structured input/context -> revisit the
  single-instructions box.
- A second host (writing app) lands -> extract the portable unit + popup into a
  shared package; this is the planned, welcome trigger.

## Naming summary

Cleanup (auto-cleanup + dictionary) · Format (name + instruction, portable unit)
· take (one Format's output) · picker (selection-driven command palette over the
Format library) · source / trigger / delivery (the per-host adapter seam).

Dead vocabulary: Transformation, pre/post-replacements, phase, step, pipeline,
prompt-template, selectedId, showInPicker.
