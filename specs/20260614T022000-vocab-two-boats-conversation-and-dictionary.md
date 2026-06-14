# Vocab as two boats: a conversation that remembers your dictionary

**Date**: 2026-06-14
**Status**: Draft, revised 2026-06-14 (see "Revision 2026-06-14" below, which is authoritative over the Data model, Modes, package, three-screens, build-order, and success-criteria sections)
**Owner**: braden
**Branch**: (unstarted)
**Supersedes**: `specs/20260613T211000-vocab-acquisition-through-use.md` (carries forward its schema, mastery-box, gloss, and staircase decisions; reframes the thesis and the app boundary)
**Related**: `specs/20260614T022000-vocab-pronunciation-stt-tts-research.md` (STT/TTS pronunciation grading research, complete; its MVP stack is folded into the Pronunciation section below)

## One Sentence

A language-learning app whose entire interface is a steerable AI role-play conversation backed by a personal vocabulary dictionary: the conversation steers you toward your due words and lets you highlight unknown ones to add, and the dictionary is the durable memory of you as a learner that every conversation reads and writes.

## Revision 2026-06-14 (greenfield simplification)

This revision is authoritative over the Data model, Modes, package, three-screens, build-order, and success-criteria sections below; those remain as the reasoning trail. The trigger was a planning pass that released all compatibility pressure (these are throwaway MVPs, never publicly released, deleted after use) and rebased onto current `main`, where two facts moved the ground:

- **doc-as-wire already merged** (PR #1930): conversation transcripts are per-conversation child Y.Docs (`zhongwenConversationDocGuid`, a streaming `Y.Text` per message), not a `chatMessages` table. `ChatMessageId` no longer exists, so the typed message provenance on `usages` below is dead.
- The design collapsed from "two boats, a package, three tables" to **one table inside zhongwen**.

### Revised one sentence

zhongwen is a Chinese chat that remembers the Chinese words you are learning: a single `vocabulary` table of words plus a self-reported comfort level, where comfort is the filter, the lens color, and the review schedule's input, and a stored `dueAt` paces you through bulk-imported lists without overwhelm.

### The model: one table, current state (never a log)

```ts
const vocabularyTable = defineTable({
  id: field.string<TermId>(),
  text: field.string(),                                 // the Chinese word/phrase; also the dedup key
  mastery: field.integer({ minimum: 0, maximum: 2 }),   // 0 new, 1 learning, 2 known. self-reported comfort. required. doubles as the list filter, the lens color, and the interval input.
  dueAt: field.date(),                                  // next review, a CALENDAR DAY. the schedule + pacing handle. required. the user can nudge it earlier or later.
  createdAt: field.instant(),                           // when added, a precise UTC MOMENT. orders the list and the import preview. the one cuttable column.
});
```

The two time fields are deliberately different *kinds* of time: **`createdAt` is a `field.instant()`** because it records a moment that actually happened (and the sub-second precision preserves insertion order when a bulk paste lands hundreds of words on one day), while **`dueAt` is a `field.date()`** because spaced repetition schedules by calendar day, never by moment. A day-granular due date makes the queue compare cleanly (`dueAt <= today`), makes "bump due now" mean today, keeps nudging day-granular, sidesteps the timezone trap where an instant's "today" flips at a UTC boundary, and keeps `dueAt = today + intervalDays(mastery)` a clean date. Rule: events are instants, schedules are dates.

KV (pacing, configurable):

```ts
kv: {
  showPinyin: defineKv(Type.Boolean(), () => true),     // existing
  newWordsPerDay: defineKv(Type.Number(), () => 10),    // caps new words entering the daily queue; how a 800-word dump does not overwhelm
}
```

### The review queue is a query, not a table or a stored list

```txt
queue(now) =
    words where dueAt <= now AND mastery > 0          // reviews that came due
  + up to newWordsPerDay words where mastery == 0     // throttled new intake
```

This is the answer to "I dumped HSK 800, now what." All 800 sit at `mastery 0, dueAt now`. The queue only ever feeds `newWordsPerDay` new words plus whatever genuinely came due. You tune one number, not 800 words. On review, grade the word: set mastery, set `dueAt = now + interval(mastery)` (a small per-mastery interval, itself a future KV so the user configures their own spacing). Coarse by design; see the clumping limitation below.

### Bulk import and re-add (the dedup-preview flow)

Paste a list (HSK levels, song lyrics, anything), one term per line, or import a file. Before committing, **preview**: which lines are new vs already in the dictionary (dedup is an import-time query on `text`, not a DB constraint). Re-adding **never creates a duplicate**; an existing word shows an indicator and offers "bump due now" (`dueAt = now`) or "reset to new" instead. Re-inputting a word you already have is a deliberate reschedule, not a junk row. The list buckets naturally by mastery (new / learning / known), and the `newWordsPerDay` throttle means you only face a handful of new words at a time.

### Refusals (with triggers)

| Candidate | Refusal | User loss | Trigger to revisit |
| --- | --- | --- | --- |
| `usages` append-only log | State over log: comfort is a mutable field, not a derived projection over an unbounded event stream that syncs forever | No history timeline, no auto-derived mastery, no jump-back-to-sentence | You want mastery computed FROM observed use (FSRS) rather than self-reported |
| `modes` system-prompt library | A separate feature (steerable role-play), not the vocab memory; the existing single system prompt runs the MVP chat | No user-authored scenarios | You want authored, reusable scenario prompts |
| `language` field (en/zh) | zhongwen is Chinese by construction; the value would be a constant. The app boundary is the discriminator | No bilingual side-by-side (a different product) | A real English-learning surface exists; decide then between a separate app and adding the field back |
| `@epicenter/vocab` package | One consumer (zhongwen) is not a seam; cheap-to-extract means extract-on-demand | None now | The future vocab app (below) reaches for the dictionary |
| mastery range 0-5 (Leitner) | Self-report's honest ceiling is about 3 states; 5 boxes only mean something when an algorithm boxes you. Widening max is non-breaking | Finer manual grades | Scheduling needs more than 3 interval tiers (then graduate mastery or add per-card intervals) |
| nullable mastery / nullable dueAt | Every tracked word has a comfort and a next-review; null states add branches for no operation | No "archived, never resurface" state | A concrete archive/retire action exists |
| derived dueAt (lastReviewedAt + interval) | The user wants to nudge the schedule directly; a stored dueAt is editable and makes the queue a trivial query | Cannot recompute intervals from full history | You move to FSRS, which recomputes from a richer per-card state |

Known limitation: a coarse `interval(mastery)` clumps reviews (many words land on the same due day). Mitigate with interval fuzzing and the daily cap; graduate to per-card intervals or FSRS when clumping hurts.

### The future vocab app (recorded, deferred)

There will be a dedicated vocab app later, its own deployable, following this same pattern (words + self-reported mastery + dueAt + a review queue), in the same spirit as how zhongwen does chat-plus-review. It is the eventual independent home for the dictionary and the concrete second consumer that triggers extracting the deferred `@epicenter/vocab` package. It is also where bilingual or English vocab (the dropped `language` field) would re-enter. Build it when the dictionary wants to live independently of the Chinese chat, or when a second app needs the same word data.

### Revised build order

```txt
1. The `vocabulary` table (5 cols) + showPinyin/newWordsPerDay KV in zhongwen.ts; brand TermId. Green typecheck + tests.
2. The Words screen: list filtered by mastery (new/learning/known); an inline self-report control writes mastery directly.
3. Bulk import + dedup-preview + re-add reschedule.
4. The review queue (the query above) + per-mastery intervals; dueAt advances on review; newWordsPerDay pacing.
5. The lens over the live transcript doc: generalize showPinyin to a vocab-highlight channel colored by mastery, plus tap-to-gloss.
6. Highlight-to-add capture from the chat doc (adds at mastery 0, dueAt now).
7. CC-CEDICT offline gloss + segmentation (its own size/license gate). Pronunciation later, per the research subpage.
```

### Revised success criteria

- [ ] One `vocabulary` table (id, text, mastery, dueAt, createdAt) lives in zhongwen's doc; no usages/modes/language tables or fields
- [ ] mastery is required, self-reported, user-editable, and drives the list filter and the lens color
- [ ] A bulk paste of HSK words lands deduped at mastery 0; re-adding an existing word reschedules instead of duplicating
- [ ] `newWordsPerDay` paces the queue so a large dump does not overwhelm
- [ ] `dueAt` advances on review and is user-nudgeable; the review queue is a query, not a stored list

## How to read this spec

```txt
Read first:
  One Sentence
  The two boats (the whole design)
  Why a new app, not zhongwen
  Data model (the delta)
  The loop

Read if challenging the direction:
  Removal / addition gradient
  Modes: the system-prompt library
  Considered and rejected

Carried forward from the superseded spec (do not relitigate):
  mastery = Leitner integer box; "scalar now, log later"
  gloss = pinyin-pro (reading) + CC-CEDICT (meaning); CC-CEDICT also does
    segmentation + capture-unit (one bundled asset, three jobs, offline)
  the practice STAIRCASE (recognize -> cloze -> produce), now expressed as the
    AI's steering policy rather than separate screens
  grading = binary "correct + natural? yes/no + one fix", not a 5-point vibe
  difficulty is derived, never a field
```

## The two boats (the whole design)

Strip the app to its irreducible objects and there are two:

```txt
  TALK (the verb)                          WORDS (the noun)
  the conversation surface         <-->    your personal dictionary
  ephemeral, many sessions                 durable, one memory of you as a learner

  reads  Words -> steer the AI toward due/target words; mark known words in the AI's lines
  writes Words <- highlight-to-add captures; your graded uses update mastery
```

Everything else collapses into the interplay. The conversation is the engine; the dictionary is the state. The dictionary is the chat's long-term memory about *you*. The essence in one line: **a chat that remembers your vocabulary.**

This is what deletes most of a normal vocab app (see the gradient table): dedicated practice screens, decks, review queues, card authoring, drill-type UIs, and Reading-as-a-separate-mode all dissolve into "the conversation, steered by the dictionary."

## Why it's zhongwen plus a vocab package (the lens decides it)

> Superseded by Revision 2026-06-14: no `@epicenter/vocab` package now (one consumer is not a seam); the dictionary lives in zhongwen. The package extraction is deferred to the future vocab app.

This reverses a `2026-06-14` mid-session call ("a new app, not zhongwen"). The deciding factor is the **lens**: the primary vocab UI is an overlay painted over a conversation, and an overlay must be rendered by the same app that owns the conversation. You cannot cleanly paint one app's word-list onto another app's chat bubbles. zhongwen already ships this exact mechanism: the "Show Pinyin" toggle (`src/lib/pinyin/annotate.ts` + the button in `+page.svelte`) walks the message text and annotates it at render time. The vocab lens is that mechanism generalized. So the conversation surface is zhongwen, evolved, not a second deployable.

The seam that earns separation is a **package, not an app**:

```txt
@epicenter/vocab  (the WORDS boat: dev-independent, testable in isolation, reusable)
  - vocabulary / usages / modes table DEFINITIONS (iso, framework-free)
  - the offline gloss + segmentation engine (pinyin-pro + CC-CEDICT)
  - mastery / box / due logic
        | imported and composed by
        v
apps/zhongwen  (the TALK boat: conversations + the lens + capture + list view)
```

| Decision | Choice | Rationale |
| --- | --- | --- |
| Separate deployable app? | No | The lens overlays the conversation; cross-app overlay is the wrong cut |
| Home for the conversation + lens + capture + list | `apps/zhongwen` | It already has conversations, a sidebar to manage them, and the overlay pattern (showPinyin) |
| The dev-independent seam | `@epicenter/vocab` package | Exports table defs + offline gloss engine + mastery logic; zhongwen imports and composes |
| Where vocab DATA lives | zhongwen's one workspace doc | The package gives defs/logic; the doc keeps capture a same-doc write and the lens fully local |
| Promote the dictionary to its own workspace/room | Deferred | Only when a SECOND app (Whispering, reading) needs the same dictionary data |
| zhongwen's "Chinese-only" name | Cosmetic; keep `ZHONGWEN_ID` | Workspace id is the sync room; rename the display later if going en + zh feels wrong |

## The lens (the core mechanic)

Generalize zhongwen's single `showPinyin` toggle into a **layered overlay** with stackable channels:

| Channel | State | Behavior |
| --- | --- | --- |
| Pinyin (exists) | on/off | ruby annotations over Chinese |
| Vocab highlight (new) | on/off | color words by mastery: new (tap to add), learning (recall / use), known (faded) |
| Tap-to-gloss (new) | always | tap any word -> offline definition (CC-CEDICT zh, WordNet or local model en) |

The same overlay drives both practice modes:

- **Recognition**: a learning-word is highlighted; tap to recall its meaning before revealing (or it renders blanked and you recall).
- **Usage**: the AI is steered to set up lines where you should deploy a learning-word; the lens marks the words it is fishing for; `detect` catches your use in the reply and grades it.

The lens is `detect(messageText, knownSet)` rendered as highlights, which is also what the existing `annotateHtml` does for pinyin. Definitions prefer a bundled dictionary over a model where one exists (exact, free, offline); reserve the model for nuance and example sentences.

## Data model (the delta)

> Superseded by Revision 2026-06-14: one `vocabulary` table (id, text, mastery, dueAt, createdAt). No `usages` (state over log), no `modes`, no `language`, no typed message provenance (doc-as-wire removed `ChatMessageId`).

Carries the superseded `vocabulary` and `usages` tables. Two changes plus one new table.

**Change 1: `usages` provenance becomes a typed in-app reference** (capture is now mostly highlight-in-chat, so provenance must point at the message, and you want to query "all words I learned in this conversation"):

```ts
const usagesTable = defineTable({
  id: field.string<UsageId>(),
  termId: field.string<TermId>(),
  kind: field.select(['encountered', 'produced', 'used']),
  text: field.string(),                                     // sentence snapshot (immutable)
  conversationId: nullable(field.string<ConversationId>()),  // in-app provenance: jump back, review a scenario's words
  messageId: nullable(field.string<ChatMessageId>()),        // the exact line you highlighted
  sourceUri: nullable(field.url()),                          // external provenance (pasted text, web)
  grade: nullable(field.integer({ minimum: 0, maximum: 5 })),
  createdAt: field.instant(),
});
```

**Change 2 (new table): `modes`, the system-prompt library** (collapses scenario + persona + teaching-style into one user-editable concept):

```ts
const modesTable = defineTable({
  id: field.string<ModeId>(),
  name: field.string(),          // "Order coffee in Beijing", "Strict grammar tutor"
  systemPrompt: field.string(),  // the USER owns this: who the AI is, what the situation is
  language: field.select(['en', 'zh']),
  createdAt: field.instant(),
});
```

The `vocabulary` table is unchanged from the superseded spec:

```ts
const vocabularyTable = defineTable({
  id: field.string<TermId>(),
  text: field.string(),
  language: field.select(['en', 'zh']),
  mastery: field.integer({ minimum: 0, maximum: 5 }),  // Leitner box; UI shows labels
  favorite: field.boolean(),
  note: nullable(field.string()),
  lastReviewedAt: nullable(field.instant()),
  createdAt: field.instant(),
});
```

`conversations` references a `modeId` (nullable); messages persist as in zhongwen. Whether `conversations` also stores `language` is a small carried-over question.

## Modes: the system-prompt library (meta-prompting)

> Superseded by Revision 2026-06-14: `modes` is deferred. The MVP runs on the existing single system prompt; a user-authored scenario library is a later feature.

The safety invariant that makes raw system prompts shippable:

```txt
final system prompt = USER's mode.systemPrompt   (the role/scenario: who, where, what)
                    + APP's vocab pedagogy block  (steer to due words, mark known words,
                                                    gloss on highlight, grade uses)
```

The user owns the role; the app owns the pedagogy and appends it. A mode's `systemPrompt` may be AI-generated (Screen 1, from your word list) or hand-authored, and is user-editable either way; the pedagogy block is appended regardless, so a prompt can set any scene but cannot disable the learning engine.

## The loop

The staircase from the superseded spec is no longer screens; it is the AI's steering policy inside one conversation:

```txt
Box 0 new      -> AI introduces the word in-scene; you highlight + add; gloss appears
Box 1 seen     -> AI re-uses it; a light recognition beat
Box 2-3 learn  -> AI sets up a line where you must produce it (cued / cloze-like)
Box 4 familiar -> free production; AI grades "correct + natural? yes/no + fix"
Box 5 known    -> used unprompted in a later scenario (real-use detection); stretch combos
```

The steerer reads the due query from `vocabulary` and weaves **consolidating words (box 3-5)** into the AI's turns, introducing a box-0 word only as a deliberate i+1 with an inline gloss. Capture (highlight-to-add) and grading (your uses) write back. STT/TTS adds a pronunciation rung (see research).

## Three screens (the surface)

> Superseded by Revision 2026-06-14: three tables collapsed to one, so the surface is Conversation (exists) + Words (the one new screen). Scenarios is gone with `modes`.

The surface is three screens, and they are the three tables one-to-one. That mapping is the tell that the decomposition is right: every other capability (lens, capture, gloss, steering, grading, pronunciation) is a behavior inside a screen, not a screen of its own. Roughly six candidate screens collapse to three.

```
Screen 1  Scenarios     <->  modes         (AI-GENERATED system prompts)
Screen 2  Conversation  <->  conversations + chatMessages   (+ the lens reads vocabulary)
Screen 3  Words         <->  vocabulary (+ usages)
```

The three form a self-sustaining flywheel, which is why growth feels natural:

```
   WORDS ───────────────────►  SCENARIOS
   (what you want to learn)    AI generates a scene that
        ▲                       naturally uses your due words
        │                              │
        │   capture new /              ▼
        └──── grade uses ───────  CONVERSATION
                                  you chat; the lens highlights
                                  your words; highlight-to-add
```

**Scenario generation has two intents**, mapping onto the staircase, both just prompt variations writing to `modes` (no schema change):

- **Reinforce**: read due/learning words (box 2-5), generate a coherent situation where they belong. Consolidation.
- **Expand**: generate a rich scenario that introduces NEW words (topic or frequency driven) for you to highlight-to-add. Acquisition.

**MVP collapses to two visible surfaces.** A scenario is a reusable template (1 scenario : many conversations), so a dedicated Scenarios gallery only earns a page once you curate and re-run templates. Until then, "generate a scenario" is an action on New Conversation (pick reinforce or expand -> AI writes the systemPrompt -> chat). Ship **Conversation + Words**; let the **Scenarios** screen appear when there is a library to browse.

Risk to design against: scenario generation has the same shoehorning failure as the weave. The generator must pick a situation where the target words plausibly belong, not stuff words into a contrived scene.

## Removal / addition gradient

| Verdict | Feature |
| --- | --- |
| Definitely removed | Dedicated Practice screen; deck management; review-queue table; card authoring / note types / templates; stored example-sentences table; `reading`/`meaning`/`partOfSpeech`/`difficulty`/`dueAt` columns |
| Likely removed | Reading mode as a separate screen (folds into "discuss a pasted text"); capture as a distinct action (becomes highlight-in-chat); `scenario`/`persona` fields (collapsed into `modes`) |
| Maybe removed | Heavy Library table UI (may shrink to a searchable list); self-rated recognition rung and manual mastery override (if AI grading + real-use carry them; seeding still needs some manual set); multi-provider model picker |
| Added | `modes` system-prompt library; the layered lens (generalized `showPinyin`); highlight-to-add + AI steering policy; typed message provenance on `usages`; STT + TTS + pronunciation grading; the `@epicenter/vocab` package seam |
| Kept (core) | `vocabulary` + `usages`; mastery box; bulk-seed / known-set; gloss via pinyin-pro + CC-CEDICT |

## Pronunciation: STT / TTS

Grounded by the research subpage (`specs/20260614T022000-vocab-pronunciation-stt-tts-research.md`). The headline: do not build GOP/Kaldi/MFA in-house. Pronunciation grading is two tiers, a free local floor and an optional cloud ceiling, and it maps onto the staircase as one more rung.

**The honest local floor (free, offline):**

- **STT round-trip**: speak the word, run local Whisper (transcribe), check it matches the target. Present this as **"recognized correctly," NOT a 0 to 100 score.** Grounded caveat (NLP4CALL 2024, ISLE corpus): Whisper logprob correlates R=-0.94 with transcription accuracy but only R=-0.57 with human pronunciation grades. So it is an honest binary, not a quality number.
- **Mandarin tone score (the differentiator)**: Whisper round-trip CANNOT catch tone errors (the language model silently corrects the hanzi). Tones need explicit pitch analysis, and the buildable local pipeline is cheap: `pYIN/CREPE F0 -> LOESS smooth -> T-value 5-level normalize -> nearest canonical tone-template (DTW)`. A few hundred lines, no deep model required (the Nature 2025 ResNet is a refinement, not a prerequisite). This is the asymmetric win: the most distinctive signal for Chinese is local, offline, and small, consistent with "the AI is the ceiling, not the floor."

**TTS (speak-aloud):** **Kokoro** (82M, Apache-2.0) is the standout: one model covers English + Mandarin with real tone, and runs in the browser (`kokoro-js`) and Tauri (ONNX / sherpa). Piper is a Tauri alternative but its maintained fork is GPL-3.0; XTTS is disqualified by license.

**Recommended MVP stack (local-first, cloud opt-in):**

| Target | TTS | STT round-trip | Tone F0 |
| --- | --- | --- | --- |
| Web | Kokoro (`kokoro-js`) | transformers.js Whisper (WASM/WebGPU) | pYIN/CREPE in JS or ONNX-web |
| Tauri | Kokoro or Piper (sherpa-rs) | whisper.cpp | pYIN/CREPE in Rust (`ort`) |

Share the round-trip + tone-template logic as a common WASM/Rust module across both targets. An optional **"deep feedback" cloud toggle, off by default**: Azure Pronunciation Assessment for English phoneme breakdown (no Mandarin tones, ~$0.002/word), SpeechSuper for a numeric Mandarin tone score (the only turnkey API that scores tones, ~$0.004 to 0.008/request). Speechace has no Mandarin.

**Design consequence:** pronunciation is a staircase rung, not a separate feature. Recognition round-trip is the floor (any box), the tone-template score is the Chinese-specific signal, and cloud phoneme/tone scoring is an opt-in upgrade. None of it gates the core conversation loop.

## Considered and rejected

| Candidate | Why rejected |
| --- | --- |
| A separate vocab deployable app | The lens overlays the conversation; cross-app overlay is the wrong cut (reverses an earlier "new app" call) |
| A `@epicenter/vocab` package now vs deferred | Build it now: it is the dev-independent seam the user wants, and it is just table defs + the gloss engine (cheap to extract, not a rewrite) |
| Two docs for Talk and Words | Re-breaks atomic capture; vocab tables live in zhongwen's one doc |
| A `scenario` / `persona` table | Collapsed into `modes` (expose the real lever, the system prompt) |
| Wrapping the system prompt so users can't edit it | Kills the meta-prompting win; instead append the pedagogy block and let users own the role |
| Keeping Practice / Reading as screens | They are the conversation; the staircase is a steering policy |

## Open Questions

1. **Language scope and the zhongwen name.** en + zh now. The home is `apps/zhongwen` (the lens settled this); its "Chinese-only" name is cosmetic, keep `ZHONGWEN_ID` and rename the display later if en + zh makes the name feel wrong. Recommendation: keep zh + en only until the loop is proven.
2. **Recurring partner vs discrete scenarios.** Largely dissolved by `modes` (a mode can be a recurring persona or a one-off scenario). Recommendation: no separate construct; it's just which mode you pick.
3. **Does the Library survive as a grid, or shrink to a list?** Recommendation: start as a simple searchable list (the ledger); add grid affordances only if curation demands them.
4. **English meaning source** (carried over): WordNet (local, dry) vs AI (nuanced, online). Recommendation: AI for nuance, since en learners want register; keep zh fully local via CC-CEDICT.
5. **Pronunciation grading depth** (resolved by research): local STT round-trip as a "recognized correctly" floor + a local pYIN/CREPE tone-template score for Mandarin; optional cloud (Azure / SpeechSuper) as an off-by-default upgrade. See the Pronunciation section.

## Build order (provisional)

> Superseded by the "Revised build order" in Revision 2026-06-14.

```txt
1. Extract @epicenter/vocab (vocabulary + usages + modes table defs + gloss/segmentation engine);
   zhongwen composes the tables into its workspace
2. The layered lens: generalize showPinyin into channels (pinyin + vocab-highlight + tap-to-gloss),
   offline via pinyin-pro + CC-CEDICT, no AI
3. Highlight-to-add capture + the list-view route (definitions from the offline engine)
4. The steering policy: due-word weave into AI turns; mark known words; modes library
5. Grading: production binary+fix; real-use detection; mastery from graded usages
6. Pronunciation: TTS speak-aloud, STT round-trip, MVP tone-template score (per research)
```

## Success Criteria

> Superseded by the "Revised success criteria" in Revision 2026-06-14.

- [ ] The vocab lens overlays a conversation (highlight by mastery, tap-to-gloss), generalizing showPinyin
- [ ] Highlighting an unknown word in an AI line adds it with typed message provenance
- [ ] The AI demonstrably steers toward due words and marks known ones
- [ ] A `modes` library lets the user pick or author a system prompt; the pedagogy block always applies
- [ ] Chinese gloss + segmentation + capture-unit work offline (CC-CEDICT)
- [ ] `@epicenter/vocab` is a standalone package zhongwen imports; vocab data lives in zhongwen's one doc

## References

- `specs/20260613T211000-vocab-acquisition-through-use.md` - superseded; source of the carried-forward schema and staircase
- `specs/20260614T022000-vocab-pronunciation-stt-tts-research.md` - pronunciation research (complete)
- `apps/zhongwen/` - the home app; reuse chat-state, `/ai/chat` transport, pinyin-pro, components
- `apps/zhongwen/src/lib/pinyin/annotate.ts` + `+page.svelte` showPinyin toggle - the overlay pattern the lens generalizes
- `packages/field/src/builders.ts` - the `field.*` vocabulary
