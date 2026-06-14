# Vocab as two boats: a conversation that remembers your dictionary

**Date**: 2026-06-14
**Status**: Draft (work in progress)
**Owner**: braden
**Branch**: (unstarted)
**Supersedes**: `specs/20260613T211000-vocab-acquisition-through-use.md` (carries forward its schema, mastery-box, gloss, and staircase decisions; reframes the thesis and the app boundary)
**Related**: `specs/20260614T022000-vocab-pronunciation-stt-tts-research.md` (STT/TTS pronunciation grading research, complete; its MVP stack is folded into the Pronunciation section below)

## One Sentence

A language-learning app whose entire interface is a steerable AI role-play conversation backed by a personal vocabulary dictionary: the conversation steers you toward your due words and lets you highlight unknown ones to add, and the dictionary is the durable memory of you as a learner that every conversation reads and writes.

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
