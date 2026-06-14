# Vocabulary: acquisition through use

**Date**: 2026-06-13
**Status**: Superseded
**Owner**: braden
**Branch**: (unstarted)
**Superseded by**: `specs/20260614T022000-vocab-two-boats-conversation-and-dictionary.md` (reframes the thesis around role-play conversation as the one interface, and moves to a new app; this spec's schema, mastery-box, gloss, and staircase decisions carry forward)
**Builds on**: `apps/zhongwen/zhongwen.ts` (the existing Chinese-AI-chat workspace this extends), `packages/field` (the field vocabulary), `specs/20260605T214500-sqlite-projection-primitives.md` (projection-over-table pattern)

## One Sentence

A vocabulary you grow by *using* words, not by authoring flashcards: words are captured in context with one tap, everything a dictionary knows is derived (never typed), and the only practice is production graded by a local model, surfaced as a layer over the chat, reading, and writing you already do, scoped to English and Chinese.

## How to read this spec

```txt
Read first:
  One Sentence
  Why this exists (and why now)
  The thesis (three commitments)
  The one primitive: inject and detect
  Data model
  Screens

Read if challenging the direction:
  Design Decisions
  Why no difficulty field
  Curation
  Considered and rejected

Context you must not relitigate:
  This extends the zhongwen workspace; it is not a new app or a new sync room.
  ZHONGWEN_ID stays. Mastery is a Leitner box, not a select (see Decisions).
  Difficulty is derived, never annotated (see "Why no difficulty field").
```

## Why this exists (and why now)

The honest failure mode of every vocab app is that it is Anki with a definition column, so it dies after a week. The authoring is heavy (you write cards), the practice is passive (you recognize, you do not produce), and nothing connects it to the language you actually read and write. Two things make a better shape possible now:

1. **Local models are good enough to derive and to grade.** Reading, meaning, and part of speech are a dictionary or model call, not a field a human fills. Practice prompts are generated. Your produced sentences are graded with feedback. The entire card-authoring surface (Anki's decks, note types, templates, editor) disappears.
2. **Epicenter already owns your writing surface.** `apps/zhongwen` is an AI chat where you converse in Chinese. That same chat is both the place words are captured *and* the place words can be reinforced by real use. No standalone app can see your real writing; this one can.

So this is not a new app. It is a `vocabulary` table plus a practice layer added to the zhongwen workspace, where capture-in-context and real-usage review come for free because the chat and the words share one doc.

## The thesis (three commitments)

Everything below serves three commitments. If a feature does not, cut it.

1. **Capture costs nothing.** Saving a word is one tap. The machine fills in everything derivable (reading, meaning, part of speech) live, offline, from a bundled dictionary or local model. The human types only judgment: a mnemonic note, a star, an initial mastery.
2. **Retention comes from production, not recognition.** The practice loop is "produce, then get graded," not "recognize, then reveal." You write a sentence using the word; a local model judges correctness and naturalness. Recognition is the low-energy fallback, not the spine.
3. **Practice is a layer, not a place.** The highest-value review is using a word for real in a chat message you were writing anyway. Practice dissolves into the chat, into reading, and into your own writing. The dedicated Practice screen is the focused fallback.

## The one primitive: inject and detect

Every feature here is one of two operations over a piece of text, given your vocabulary graph (your known-set plus a priority queue of due/weak words):

```txt
inject(textBeingGenerated, targetWords)  -> weave your due/weak words into output
detect(textBeingRead, knownSet)          -> find your words, gloss the unknown,
                                            capture the new, grade the used
```

That is the whole engine. Pointed at different surfaces, it is every feature:

| Surface | Operation | What it does |
| --- | --- | --- |
| AI chat turn | inject | AI converses while seeding your target words at a tuned density |
| Your chat reply | detect | your real uses are graded and advance mastery (no extra friction) |
| Arbitrary reading text | detect | known words invisible, unknown words tappable, new words auto-captured |
| Your own draft | detect | proactive coaching: "you could have used X here" |
| Focused practice | inject | a concentrated weave: prompts built from your due words |

**The load-bearing asymmetry: `detect` is the robust floor, `inject` is the high-ceiling bet.** Detection is mostly a dictionary plus a segmenter (jieba-style word boundaries for Chinese, a lemmatizer for English so "ran" matches "run"). It works offline, deterministically, no large model. Injection (weaving specific words naturally, grading nuance) needs a capable model and careful prompting, or it shoehorns. **This dictates the build order**: ship detection first, layer injection on as the model allows.

## The conversation as a tunable comprehensible-input engine

The headline `inject` instance, and the reason this lives in zhongwen. The AI converses with you and deliberately seeds your target words at a controlled density and difficulty, so every conversation is a lesson tuned to your exact vocabulary (comprehensible input: words slightly above your level, meaning recoverable from context). Mechanics:

- **Weave budget**: aim for N target words per turn from a priority queue (due > weak > favorites > recent). A *target, not a quota*: skip words that do not fit naturally. Quality of weave beats quantity.
- **Mastery-gated scaffolding**: low-mastery words used in obvious context or glossed inline; high-mastery words used plainly. Treatment changes as you improve.
- **i+1 stretch**: occasionally introduce one word just above level, then make its meaning recoverable from context.
- **Bidirectional**: the AI's uses are exposure; your replies' uses are graded production. One turn can advance many words.
- **Multi-word turns**: combine two or three due words in one sentence to force relating them, reviewing several words at once.
- **Echo discounting**: parroting the AI's sentence is not production; grading must distinguish genuine use from echo.

## Data model

Lives in the zhongwen workspace alongside `conversations` and `chatMessages`. Two tables. A thin word, and an append-only usage log that absorbs three things (the context you met a word in, the drills you produced, the real uses detected in your writing) into one shape.

```ts
import { field } from '@epicenter/field';
import { defineTable, nullable } from '@epicenter/workspace'; // nullable is substrate policy, not a field kind

// The word: capture + judgment only. Everything else is derived or logged.
const vocabularyTable = defineTable({
  id:        field.string<TermId>(),
  text:      field.string(),                          // the word/phrase, native script
  language:  field.select(['en', 'zh']),              // detected on capture; dispatch key

  mastery:   field.integer({ minimum: 0, maximum: 5 }), // Leitner box; cached projection of usages
  favorite:  field.boolean(),                          // your star
  note:      nullable(field.string()),                 // your mnemonic: the one pure annotation

  lastReviewedAt: nullable(field.instant()),           // fact; dueAt is DERIVED from this + mastery
  createdAt: field.instant(),                          // capture time
});

// Every sentence this word ever lived in. Append-only, CRDT-clean.
const usagesTable = defineTable({
  id:        field.string<UsageId>(),
  termId:    field.string<TermId>(),
  kind:      field.select(['encountered', 'produced', 'used']), // met it / drilled it / used for real
  text:      field.string(),                           // the sentence
  sourceUri: nullable(field.url()),                     // which chat / article / transcript
  grade:     nullable(field.integer({ minimum: 0, maximum: 5 })), // AI grade when produced/used
  createdAt: field.instant(),
});
```

KV (generalizing zhongwen's `showPinyin`):

```ts
kv: {
  showReading:  defineKv(Type.Boolean(), () => true),   // pinyin/IPA toggle, was showPinyin
  weaveDensity: defineKv(Type.Number(), () => 1),       // target words per chat turn
}
```

### Fields that were killed, and where they went

| Killed field | Where the need is met |
| --- | --- |
| `reading` (pinyin/IPA) | `romanize(text, language)`, derived on display, not stored |
| `meaning` / definition | dictionary or model fetch, live; the sense you care about is in the captured usage |
| `partOfSpeech` | comes free with the dictionary fetch |
| `dueAt` | derived: `lastReviewedAt + interval(mastery)` |
| `updatedAt` | the CRDT tracks change; `lastReviewedAt` covers "recent activity" |
| `context` / `sourceText` | the first `encountered` row in `usages` |
| `tags` | deferred until a real grouping need appears |
| `difficulty` | derived from graded usages (FSRS-style); never annotated. See below. |

### Mastery: a Leitner box, written now, projected later

`mastery` is `field.integer` (0 to 5), not a `field.select` of named levels, because it *schedules*: correct recall bumps `box + 1`, a miss resets, and `interval(box)` drives due-ness. An integer is ordinal-honest, supports the arithmetic, and is exactly what the log derives later. Named labels (`New / Learning / Familiar / Known`) live in the UI, mapped from the integer; order and arithmetic live in the data.

Today mastery is **written directly** (seeded at add-time, bumped by practice). The intent is that it becomes a **pure projection** of graded `produced`/`used` usages once the log is authoritative (the "scalar now, log later" bridge). Keep it as a column either way so the Library can sort by it without recomputing every render.

## Why no difficulty field

You asked whether the user should mark words by difficulty. No, and it is a Class 2 (design-coherence) decision.

- **Difficulty is derived, not annotated.** FSRS, the modern spaced-repetition algorithm, treats difficulty as a real parameter *separate* from mastery, but it *computes* it from your performance and never asks you. By the rule we killed every other field with ("a model can derive it, so do not store it as annotation"), difficulty fails.
- **What you actually want is mastery seeding.** "Mark as easy / I already know this" is not a difficulty axis; it is starting a word at a high box. That is one add-time control, not a parallel field a user maintains forever. Two scales that both feel like "how I am doing with this word" would just confuse which to set.
- **Seeding "Known" has a systemic role.** It populates the **known-set** the comprehensible-input engine needs to stay at your level. So "I already know these 200 words" is not only skipping drills, it calibrates the whole inject/detect engine.

If a genuine "this is hard, drill me more" intent shows up that mastery cannot express, it is a `focus` bit (closer to `favorite`), not a difficulty scale. Logged below as a revisit trigger.

## Curation

Curation needs **no new schema fields.** It is an affordance over the model above: bulk add plus mastery seeding.

Two add modes that matter, same table, differ only by initial `mastery`:

```txt
Add learning targets   -> mastery 0, lastReviewedAt null  -> due now, enters the queue
Add known vocabulary    -> mastery 5, lastReviewedAt now    -> not due, becomes known-set baseline
```

Bulk-add mechanics:

- **Paste a list**: textarea, one term per line. Language auto-detected per line, or set for the batch. Reading/meaning derived lazily in the background, never blocking the import on N dictionary calls.
- **Import a file**: CSV (`text`, optional `mastery`), an Anki export, or a frequency list (HSK levels, top-N English).
- **Bulk mastery**: the batch defaults to one initial mastery ("I want to learn these" = 0, "I already know these" = 5); multi-select to override after.
- **Dedup**: adding an existing word merges or skips, keyed on `(text, language)`. Never duplicates.

A bulk-added word has zero usages until you practice or use it (`context` is the first `encountered` usage, which a manual add does not have). That is fine; the word stands alone.

## Screens

Practice being a layer means fewer dedicated screens than a flashcard app, not more.

```txt
Library   (home)   table of words; filters are QUERIES not folders; row drawer for detail
Reading   (new)    paste/open any text; detect glosses unknown, captures new; reading = practice
Practice  (mode)   focused chat with the weave dial up; the fallback for concentrated drilling
Capture   (action) "Save word" in zhongwen, or a quick-add box; not a screen
```

**Library**: the spreadsheet. Columns: `text` (reading toggle), a compact mastery indicator, a star, a "due" badge, a language chip. Filter pills are queries: Due (`lastReviewedAt + interval(mastery) <= now`), Favorites, Weak, Recent, by language. No deck management, because there are no decks. Clicking a row opens a drawer (not a route): live-derived gloss, the captured context, your editable note, usage history, a provenance link back to the chat, mastery override, "Practice this."

**Reading**: the one genuinely new surface, because reading-as-capture-as-practice is too good to bury in a drawer. Pure `detect`: known words invisible, unknown tappable, tapping a new one auto-captures it with its sentence. This is the Zhongwen-extension hover-lookup magic, justified because it feeds the same workspace.

**Practice**: not a separate card engine. It is "turn `weaveDensity` up on a chat" for concentrated sessions: the AI builds prompts from your due words, you produce, it grades.

## en and zh: two cases in three functions

Scoping to English and Chinese proves the language-keyed design and stresses different muscles:

| | zh | en |
| --- | --- | --- |
| segmentation | required (no spaces); jieba-style | trivial (whitespace) + lemmatizer for matching |
| reading | load-bearing (pinyin) | mostly optional (IPA) |
| the hard part | recognition + pronunciation + production | nuance + register + production |

The common core ("produce, then grade") is identical. Everything that differs is routed by the `language` field through three functions: `romanize(text, lang)`, `segment(text, lang)`, and the prompt/grade templates. Adding Japanese later is new cases in those functions, not a new app.

## Design Decisions

| Decision | Class | Choice | Rationale |
| --- | --- | --- | --- |
| Where it lives | 2 coherence | Extend the zhongwen workspace; keep `ZHONGWEN_ID` | Capture-in-context and real-usage review require chat + words in one doc; changing the id orphans existing conversations |
| Mastery type | 2 coherence | `field.integer` Leitner box (0 to 5), labels in UI | It schedules; integer is ordinal-honest, supports bump/reset arithmetic, and is what the log derives later |
| `dueAt` storage | 2 coherence | Not stored; derive from `lastReviewedAt + interval(mastery)` | Store the fact, compute the schedule; `lastReviewedAt` is already log-shaped |
| Reading/meaning | 1 evidence | Derived live, not stored; bundle a dictionary (CC-CEDICT for zh) | Deterministic from `(text, language)`; storing is a stale copy. Verify CC-CEDICT size/license before bundling |
| Usage log vs inline context | 2 coherence | One `usages` log (encountered/produced/used) | Production practice needs to keep your sentences; the log unifies context + attempts + real-uses and is the "log later" graduation |
| Difficulty field | 2 coherence | Rejected; derived from log, seeded via mastery | FSRS computes difficulty, never asks; "mark as easy" is mastery seeding |
| Curation | 2 coherence | Affordance only, no new fields | Bulk add + mastery seeding over the existing model |
| Practice shape | 2 coherence | Production-graded, recognition as fallback | Generation effect; production is where retention lives |
| Build order | 1 evidence | detect (offline, dictionary) before inject (model-gated) | Detection is deterministic and robust; injection needs model quality |
| `showPinyin` | 2 coherence | Generalize to `showReading` | Pinyin is `romanize(text, 'zh')`; the toggle is language-agnostic |
| Production vs recognition mastery | Deferred | Single `mastery` for now | Splitting into two scalars complicates everything downstream; revisit if one number proves too coarse |

## Considered and rejected

| Candidate | Why rejected |
| --- | --- |
| Standalone `apps/vocab` | Duplicates language infra (romanize/TTS), separate sync room breaks the save-from-chat flow; UI can split later, data stays one workspace |
| `difficulty` field | Derived from performance; "mark easy" is mastery seeding (see above) |
| Stored example sentences | Generated on demand; persist only the captured context and pinned uses |
| `select` for mastery | Unordered; smuggles order through array position, no arithmetic for bump/reset |
| Separate review-queue table | "Due" is a query over `vocabulary`, not a table |
| `tags` at MVP | Premature grouping; favorite covers the one real flag; add when a deck need is concrete |
| Network-only definitions | Breaks local-first (no Wi-Fi, no meanings); bundle a dictionary or use the local model |

## Implementation Plan

### Phase 1: Capture and Library (the detection floor, minimal)

- [ ] **1.1** Add `vocabulary` and `usages` tables + `showReading`/`weaveDensity` KV to the zhongwen workspace; brand `TermId`, `UsageId` with `generate*`/`as*` per the existing id pattern
- [ ] **1.2** `romanize(text, lang)` and a bundled dictionary lookup for zh (CC-CEDICT) and en; gloss derived live, nothing stored
- [ ] **1.3** Library screen: table + query filters (Due/Favorites/Weak/Recent/language) + row drawer (gloss, context, note, mastery override, favorite)
- [ ] **1.4** Capture action: "Save word" from a zhongwen chat message (writes the word + first `encountered` usage with `sourceUri`), plus a standalone quick-add box
- [ ] **1.5** Bulk add: paste-a-list and CSV import with per-batch initial mastery and `(text, language)` dedup
- [ ] **1.6** Manual mastery seeding at add-time (New/Familiar/Known); "Known" sets box 5 + `lastReviewedAt = now`

### Phase 2: Reading mode and self-rated practice

- [ ] **2.1** `segment(text, lang)` (jieba-style zh, lemmatizer en) for matching known words in running text
- [ ] **2.2** Reading screen: `detect` glosses unknown words, marks known invisible, taps auto-capture new words with their sentence
- [ ] **2.3** Cloze-from-context: blank the word in its captured `encountered` sentence; self-rate bumps the box
- [ ] **2.4** Derive `dueAt` and surface the due queue; recognition self-rate as the low-energy loop

### Phase 3: Production and the weave (the injection ceiling)

- [ ] **3.1** Production practice: model generates a prompt from a due word, you produce, model grades + feedback; write a `produced` usage with `grade`; box bumps from the grade
- [ ] **3.2** Conversational weave: inject due/weak words into zhongwen AI turns at `weaveDensity`, mastery-gated scaffolding, i+1 stretch, multi-word turns
- [ ] **3.3** Real-usage review: `detect` your genuine (non-echo) uses in chat replies, write `used` usages, advance mastery
- [ ] **3.4** Begin projecting `mastery` from graded usages instead of writing it directly

### Phase 4: Depth (later)

- [ ] **4.1** Proactive coaching on your drafts ("you could have used X")
- [ ] **4.2** Audio: TTS listening drills (`speak(text, lang)`), then STT spoken production
- [ ] **4.3** zh character decomposition (radicals, related characters)
- [ ] **4.4** Export to Anki (de-risks the bet: be additive, not a replacement)

## Edge Cases

### Chinese word matching without spaces

1. A known word `慢慢` must be found inside `他慢慢地走`.
2. Naive substring match over-matches (`慢` inside `慢慢`) and mis-segments.
3. Needs real segmentation; see Open Questions. Detection quality here gates Reading mode and real-usage review.

### Echo vs genuine production

1. The AI uses `慢慢` in its turn; you reply repeating the same sentence.
2. Counting that as production inflates mastery falsely.
3. Grading must discount uses that closely echo recent AI text.

### Heteronyms (multiple readings)

1. `行` reads `xíng` or `háng` depending on context.
2. A single derived reading can be wrong.
3. Allow a one-time correction stored on the word (the rare case where reading earns a column); otherwise derive.

### Offline

1. No network.
2. Reading/meaning must still resolve.
3. Bundled dictionary (zh) and local model (en nuance) carry it; never block on a network API.

## Open Questions

1. **How does `detect` match words in Chinese text?**
   - Options: (a) bundled jieba-style segmenter, (b) local model segmentation, (c) greedy longest-match over the known-set + dictionary.
   - **Recommendation**: (a) for robustness and offline; it is deterministic and the detection floor depends on it. Leave open pending a size/quality check.

2. **How is `mastery` computed from graded usages once the log is authoritative?**
   - Options: (a) simple Leitner bump/reset, (b) FSRS over the grade history, (c) custom.
   - **Recommendation**: start (a), keep the door open to (b); FSRS is the place derived difficulty would re-enter, as a computed parameter, not a field.

3. **Local vs cloud model for `inject`?**
   - Weaving N words naturally and grading nuance may exceed a small local model.
   - **Recommendation**: detection stays local always; allow the weave/grade to use the better model when available, degrade to self-rate when not. Defer the split until Phase 3.

4. **Does the conversational weave reuse `conversations`/`chatMessages` or get its own thread type?**
   - **Recommendation**: reuse; add `language` to `conversations` so chat and vocab share one notion of language. Defer until Phase 3.

## Decisions Log

- Keep `mastery` as a written column (not yet a pure projection): the usage log is not authoritative until Phase 3.
  Revisit when: Phase 3.4 lands and graded usages can drive it.
- Reject `difficulty` / `focus`: mastery seeding + favorite cover the stated needs.
  Revisit when: a "drill this harder" intent appears that mastery cannot express and favorite does not fit.
- Defer production-vs-recognition mastery split: one scalar for now.
  Revisit when: a single number visibly mis-schedules (you can recognize a word you cannot produce, and it keeps surfacing as "known").

## Success Criteria

- [ ] Saving a word from a zhongwen message is one tap and types nothing derivable
- [ ] A bulk paste of words lands deduped, with a chosen initial mastery, glosses filling in the background
- [ ] "Known" seeding populates a known-set the weave/reading engine respects
- [ ] Reading mode glosses unknown Chinese words correctly inside space-free text and auto-captures on tap
- [ ] Production practice grades a real sentence and advances the box; the due queue resurfaces words
- [ ] No `difficulty`, `reading`, `meaning`, `dueAt`, or `updatedAt` column exists; each is derived or logged
- [ ] Typecheck and the zhongwen workspace tests pass with the two new tables

## References

- `apps/zhongwen/zhongwen.ts` - the workspace this extends; id pattern, table/KV/action shape to mirror
- `apps/zhongwen/zhongwen.browser.ts`, `apps/zhongwen/project.ts` - composition entrypoints to wire the new screens
- `packages/field/src/builders.ts` - the `field.*` vocabulary used for the schema
- `apps/wiki/src/lib/workspace/schema.ts` - a multi-table `defineTable` example to follow
- `specs/20260605T214500-sqlite-projection-primitives.md` - projection-over-table (mastery as projection, queue as query)
