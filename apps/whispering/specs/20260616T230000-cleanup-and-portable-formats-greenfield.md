# Cleanup and Portable Formats: Replace Transformations with an Automatic Correction Layer and a Reusable Text-Action Library

**Date**: 2026-06-16
**Status**: Draft (greenfield; compatibility with the current transformation model explicitly released)
**Owner**: Braden
**Branch**: none yet

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
Read first:        One Sentence, Why the old model is wrong, The two concepts
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

- **Auto-cleanup**: one AI tidy pass. A toggle, on by default. The median user
  never touches it. Its instruction ("Fix grammar and punctuation, keep my
  wording.") is editable under advanced only.
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
```

What is deliberately absent from `Format`, versus today:

- no `preReplacements` / `postReplacements` (correction is Cleanup's job, run once)
- no `systemPromptTemplate` + `userPromptTemplate` split (one `instructions`)
- no `{{input}}` placeholder (input is implicitly the corrected text)
- no per-Format `inferenceProvider` / `model` (one global default; advanced
  override is a later, purely additive change, refused for v1)
- no `showInPicker` flag (if you made a Format you want it; delete it otherwise)

Model and provider come from a single global AI default (Settings -> AI), not
from the unit. This was an explicit decision: per-object model selection is the
kind of power-knob that makes the editor look intimidating for a feature 95% of
users will not touch, and it is additive later if real demand appears.

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
transcript stored underneath (the recording already holds it) and deliver the
cleaned version, so "show original" is always one click away. This is the one
place worth spending a little complexity.

The runner signature stays source-agnostic (it already is today:
`run({ input: string, format })` takes arbitrary text). `recordingId` becomes a
write-only bookkeeping tag on history, nullable, never load-bearing.

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

Compatibility is released; this is a clean break, not an alias layer.

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
Wave 1  Data model + runner reshape
        - add Cleanup (settings) + Format (table), delete Transformation table
        - runner takes { input, format }; remove pre/post from the Format path
        - keep raw transcript stored underneath the cleaned one
Wave 2  Automatic path
        - post-transcription runs Cleanup (dictionary -> auto-cleanup)
        - delete transformation.selectedId
Wave 3  Manual path + picker
        - Formats library page + sticky-note editor
        - repoint the existing candidate picker at Formats (source = transcript/clipboard)
        - ship default Formats
Wave 4  Migration + cleanup
        - migrate existing transformations per the rules above, one-time notice
        - delete dead UI (pre/post sections, prompt-template split, model picker)
Later   Writing-app host (separate consumer; triggers package extraction)
```

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
