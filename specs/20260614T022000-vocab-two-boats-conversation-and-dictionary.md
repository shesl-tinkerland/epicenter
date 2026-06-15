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
7. Tap-to-gloss via the model, no CC-CEDICT and no segmenter: tappable highlight spans + a "What's this?" action on the step-6 selection toolbar. See "Step 7 collapsed" below. Pronunciation later, per the research subpage.
```

### Revised success criteria

- [ ] One `vocabulary` table (id, text, mastery, dueAt, createdAt) lives in zhongwen's doc; no usages/modes/language tables or fields
- [ ] mastery is required, self-reported, user-editable, and drives the list filter and the lens color
- [ ] A bulk paste of HSK words lands deduped at mastery 0; re-adding an existing word reschedules instead of duplicating
- [ ] `newWordsPerDay` paces the queue so a large dump does not overwhelm
- [ ] `dueAt` advances on review and is user-nudgeable; the review queue is a query, not a stored list

### Step 4 as built: the queue steers the conversation (2026-06-14)

Step 4 shipped without a review screen and without spaced-repetition intervals, which corrects the last success criterion above (`dueAt` does not advance on review). The review queue is a pure selector, `reviewQueue(words, { today, newWordsPerDay })` in `apps/zhongwen/src/lib/review.ts`, whose only consumer is the conversation system prompt: on each generation kickoff, `ConversationView` feeds the in-play words into a steering block (`buildVocabularySystemPrompt`) so the AI weaves them into the scene instead of the user drilling them on a card. A word is in play when `mastery < 2` (not retired) and `dueAt <= today`. There is no `/review` route, no `intervalDays`, no `dueAt` advancement, and no `grade` action: the self-report toggle already on the Words screen is the whole grading path, and marking a word Known retires it because the selector filters it out. The deleted interval machinery only earned its keep when a drill was the sole exposure; the conversation is the repetition, so a word stays in play until you self-report it Known.

This redefines two fields from the model above:

- **`dueAt` is now a manual snooze/nudge cursor**, not an auto-advancing schedule: "do not surface this word in conversation until this day." Nothing advances it automatically; it moves only through the bulk-import bump/reset (step 3) and a future manual nudge. The queue compare (`dueAt <= today`) is the snooze gate.
- **`mastery` is self-reported comfort with no predictions and no auto-change.** Exposure in a conversation never changes mastery; only the user does. This keeps the two axes independent: `dueAt` is scheduling, `mastery` is comfort, and the only automatic decision is which words to feature today, never how well you know them.

Open questions this surfaces (deferred, with triggers):

- **Airtime / rotation.** With no bump, every in-play word is fed to every conversation, which floods the prompt and removes variety once the list grows past a handful. The fix is rotation (airtime), not spaced repetition. Two ways: sample a capped handful per conversation (stateless, no chat-time writes, `dueAt` stays purely manual), or auto-bump `dueAt` on exposure (a rotation cursor, but it writes on every chat and risks intra-conversation churn when targets are recomputed per message). Prefer sampling. Trigger: a real conversation feels flooded or monotonous.
- **Knowing the meaning landed.** You do not truly know whether the user understands a word; self-report is the honest best-effort signal, and a wrong call is cheap to recover (re-add, or leave it in Learning). AI-graded usage detection over the transcript is the richer answer and is steps 5 to 6 territory. Trigger: self-report feels like too much manual bookkeeping.

### Two roles per conversation: recognize vs use (2026-06-14)

There are two relationships a learner can have to a word, and they are the real structure behind the GRE intuition (most words you only need to read; a chosen few you want to wield yourself):

- **Recognition.** You understand the word when you meet it. This is where most words stop, and stopping here is a legitimate finish, not a failure.
- **Production (use).** You can deploy the word yourself, unprompted. The chosen subset you want to actively wield.

The decisive design point: **these are not two axes, they are one ordered ladder.** You cannot produce a word you cannot recognize, so production sits *above* recognition on a single comfort value, never beside it. A second slider (a separate "usage comfort") would let you record impossible states (high usage, low recognition) and is refused for the same reason the 0-5 / two-integer grid was: comfort has one honest direction.

```txt
not tracked → recognizing → recognized ──(opt-in fork)──▶ producing → fluent
                                │                              │
                       terminal happy state            the wield subset; earns
                       (most words stop here)           its rungs only once a
                                                        production-grading
                                                        consumer exists
```

**The role is derived per conversation, never stored.** This is what makes the recognize/use split free and what keeps the dead `use` boolean buried (see the refusal below). On each kickoff the queue's in-play words are sorted by comfort and handed to the AI as two buckets:

- New words (mastery 0) → **recognition role**: the AI introduces them in its own lines with an inline gloss.
- Learning words (mastery 1) → **production role**: the AI sets up openings where the learner must supply the word themselves, without saying it for them.

This is implemented in `buildVocabularySystemPrompt` (`apps/zhongwen/src/routes/(signed-in)/chat/system-prompt.ts`): the same function that used to dump one undifferentiated blob now steers two buckets. The split is mutually exclusive *per conversation* (a word is in exactly one bucket today) but not fixed: a word migrates from recognition to production as the learner bumps its comfort. The conversation steering is the **consumer** that finally makes recognize-vs-use earn its keep, which the bare flag never had.

Coarse-cut limitation: New = recognize, Learning = produce lumps "barely know it" with "almost have it." Acceptable to start. Trigger to refine: the production bucket feels too blunt, at which point either split Learning into more rungs or add the wield fork (below), never a second slider.

### The reflection grading moment (recorded, partially deferred)

Self-report currently lives only on the Words screen, divorced from the moment of use. The richer placement is a **reflection step bound to finishing a conversation**: when the learner deliberately wraps up a chat, surface the words this chat was practicing and let them bump comfort while the experience is fresh.

Design constraints (so it stays a payoff, not a tax):

- **Skippable.** Closing or navigating away without grading is always free; grading attaches only to an explicit "Finish / wrap up" action.
- **Scoped.** Show only this chat's steered words, not the whole dictionary. v1 roster = the in-play words fed to the prompt (a recompute, free). v2 roster, once the lens (step 5) exists = the words that actually *appeared* in the transcript.
- **One-tap bumps**, not a form. The reflection reuses the same self-report control the Words screen owns; it is a new *moment* for that control, not new machinery.

Lifecycle binding: grading attaches to **Finish / archive**, never to **delete**. Delete means "throw this away," so it skips grading entirely; forcing a grading ritual before a destructive action is hostile. A distinct "archived" conversation state is deferred until the conversation list is cluttered enough to want it; until then "Finish & review" just leaves the chat in the list.

Built now: the two-role split (above) and a reflection screen over the existing three levels (New → Learning → Known). Deferred: the screen's value is the *moment*, not extra rungs, so prove the moment first.

### The wield fork and the compose surface (vision, gated)

The one place a genuine second dimension appears is **wield intent**: among words already recognized comfortably, the chosen few you want to push into production anyway. Plain comfort says "recognized, retire it"; wield intent says "keep climbing this one." It is the opt-in fork at the top of the ladder, not a parallel boolean, and it earns the `producing`/`fluent` rungs only when a real production consumer exists. Self-reported "I used it" is too weak to feed a new rung (people over-claim); it would recreate the decoration problem in subtler form.

The endpoint the fork walks toward is a **compose / output surface**: the learner writes (or speaks) something and the app checks which wield-target words they actually deployed. That measures active vocabulary by *production* instead of asking the learner to declare it, and it is the only honest answer to "comfortable using a word." It is the true north for the productive side of the app, not a footnote; everything shipped so far is recognition machinery.

| Candidate | Refusal | Trigger to revisit |
| --- | --- | --- |
| `use` boolean on a word | Fuses "focus on" with "produce"; breaks the `mastery < 2` retire rule (a Known+use word can never exit); no consumer reads it. The recognize/use split is derived per conversation, not stored | Never as a boolean. Wield intent returns as the ordered fork below, not a flag |
| Second comfort slider (recognition vs usage) | Usage requires recognition, so the two collapse onto one ordered ladder; a second axis encodes impossible states | Never; refine the single ladder with more rungs instead |
| `producing` / `fluent` rungs above Known | No production-grading consumer exists; a self-report-only rung is decoration | AI usage-detection over the transcript, or the compose surface, gives the rung a real signal |
| Reflection grading on delete | Delete is "throw away"; grading before a destructive action is hostile | Never; grading binds to Finish / archive only |

### Step 5 as built: the vocab-highlight lens (2026-06-14)

Step 5 shipped the highlight channel of the lens, not yet tap-to-gloss (which depends on the CC-CEDICT offline dictionary, step 7). The lens is two pieces:

- **The matcher** (`apps/zhongwen/src/lib/lens/match.ts`): `findVocabMatches(text, words)` splits a stretch of Chinese into an ordered list of plain-text and matched-word segments, longest-match-first (Chinese has no spaces, so matching is dictionary-driven). This is the reusable core. The reflection roster (the "what actually appeared in this transcript" set) will reuse it over the full transcript, the AI's lines and the learner's, which is why building the lens before the reflection screen was the right order.
- **The highlight overlay** (`apps/zhongwen/src/lib/lens/highlight.ts`): `highlightVocabHtml` wraps matched words in mastery-colored spans (New and Learning underlined to pop, Known faded back). It generalizes the existing `annotateHtml` pinyin overlay and composes with it: highlight first (whole terms), then pinyin annotates the text inside each span. A `highlightVocab` KV (default on) and a "Show Words / Hide Words" header toggle drive it, exactly mirroring `showPinyin`.

This keeps the live conversation a conversation: the only persistent vocab UI in the chat is the lens (recognition words are visibly painted onto the AI's lines). Accounting (targets, grading) stays at the edges per the two-roles and reflection sections above. Currently the lens highlights assistant messages; highlighting the learner's own words (their production) folds in with the reflection roster work, since both need the matcher run over user text.

Deferred from step 5, with triggers:

- **Tap-to-gloss.** A highlighted word should be tappable for its meaning. The English/Chinese gloss needs the offline dictionary (step 7); a pinyin-only tap (pinyin-pro is already a dependency) plus an in-chat comfort bump is a cheaper interim. Trigger: build alongside step 6 capture or step 7 gloss.
- **Highlight-to-add capture** (step 6): tapping an un-tracked word to add it at mastery 0. The matcher already distinguishes tracked from untracked text, so capture is the inverse selection.

### The reflection screen as built (2026-06-14)

The reflection moment from "The reflection grading moment" above is built, on the v2 (accurate) roster the lens enabled. This is the first thing the conversation **writes back** to the dictionary: until now TALK only read WORDS (step 4 steering, step 5 lens). Finishing a chat now bumps comfort on the words it practiced.

- **The roster** (`apps/zhongwen/src/lib/reflection.ts`): `reflectionRoster({ messages, words, inPlay })` runs `findVocabMatches` over the transcript and splits the dictionary into three mutually exclusive buckets, `used` (appeared in the learner's messages, production wins the tie), `met` (appeared only in the AI's messages), and `missed` (today's steering targets that never surfaced). Pure selector, no doc reads or writes; 7 tests. This is exactly the matcher reuse the step-5 note predicted, which is why the lens came first.
- **The sheet** (`apps/zhongwen/src/routes/(signed-in)/components/ReflectionSheet.svelte`): a bottom sheet over the chat (the moment, not a navigation away), opened by a "Finish & review words" button in `ConversationView` that shows once a chat has messages. Each row is the self-report control, now extracted to `components/MasteryToggle.svelte` and shared with the Words screen (with `$lib/mastery.ts` for the labels), so the reflection is a new *moment* for that control, not new machinery, exactly as the spec required.

Two design points settled in the build:

- **The roster is snapshotted at Finish, not reactive.** A bump writes mastery through immediately, but the buckets are frozen for the duration of the review so a word does not vanish from "didn't come up" the instant you mark it Known. The row's toggle still reflects the live value (it reads current mastery from the live `vocabularyWords` by id), so the snapshot freezes membership, never the displayed choice.
- **No new transcript read.** The roster runs over `messages`, the same `readChatDocMessages` array `ConversationView` already holds; the flagged "one new read of the child doc" turned out to be a read that already existed.

Lifecycle held to the spec: Finish is skippable (closing the sheet bumps nothing), binds only to the explicit action (never to delete or navigate-away), and leaves the chat in the list (no archive state yet). Highlighting/grading the learner's own words now has its first home here; the lens highlighting user messages in-chat still folds in with step 6.

Deferred, with triggers:

- **Used/met show every appearance regardless of mastery**, so a common Known word the AI happened to say lands in "you met." Honest but potentially noisy. Trigger: a real reflection feels cluttered with already-retired words, then filter `met`/`used` to `mastery < 2`.
- **The "missed" bucket only offers a comfort bump, not a snooze.** Nudging `dueAt` to defer a word that did not come up is the natural action there but has no UI yet. Trigger: a manual dueAt-nudge control exists (the deferred half of step 4's snooze cursor).

### Step 6 as built: highlight-to-add capture (2026-06-14)

Capture is the second write-back from TALK to WORDS (reflection was the first): see a word in the chat you do not have yet, select it, add it. `SelectionCapture` (`apps/zhongwen/src/routes/(signed-in)/components/SelectionCapture.svelte`) watches text selections scoped to the chat scroll container and, for a short Han-script selection, floats an "Add <word>" button at the selection. Clicking it calls `captureWord` in `ConversationView`, which writes the same entry the Words screen's single-add does (mastery 0, `dueAt` today, `createdAt` now) and dedupes on exact text (re-adding is a no-op with an info toast).

The one design turn from the spec's sketch: the spec imagined capture as "the inverse selection" of the matcher (the untracked segments become tappable adds). That only works once the text is segmented into words. Without CC-CEDICT (step 7) an untracked run is a whole multi-word stretch with no internal boundaries, so tapping it would add a sentence fragment, not a word. A free **text selection** is therefore the honest capture unit for now: the learner draws the word boundary themselves and we capture exactly that. The matcher-driven tap-to-add-word becomes viable only after step 7 makes each untracked word its own unit; until then `findVocabMatches` earns its keep on the render side (the lens) and the reflection roster, not capture.

Deferred, with triggers:

- **Re-add reschedule in chat.** Selecting a word you already have just toasts "already in your words". The bulk-import flow offers bump/reset on a duplicate; the same could surface here. Trigger: re-capturing a known word to reschedule it feels wanted.
- **Tap-to-add (no drag).** Once segmentation exists, an untracked word can be a single-tap add, lighter than a selection. Folds in with step 7.
- **Capturing from your own messages.** The selection listener already covers the whole chat, including user bubbles, so this works today; it is called out only because highlighting the learner's own words (the lens over user text) is still deferred to the reflection-roster follow-up.

### Step 7 collapsed: selection is the gloss-unit, no dictionary and no segmenter (2026-06-14)

Step 7 as drawn ("CC-CEDICT offline gloss + segmentation") was the last build-order item and the only one behind a size/license gate. A grounding pass collapsed it to nearly nothing by asking what segmentation was ever load-bearing for. None of its three consumers actually need it:

- **Capture (add a word) already shipped** in step 6 as a free-text selection. The human draws the word boundary; segmentation was only ever going to make that a single tap instead of a drag, an ergonomic upgrade, not a capability.
- **The lens highlight** only paints *tracked* words, which `findVocabMatches` already finds by longest-match over the personal list. Segmentation would fix a few ambiguous-substring edge cases; marginal.
- **Gloss** is the only genuinely new feature, and a *model* gloss needs no clean boundary. The model is contextual: hand it a sloppy or over-long span (or one character plus its sentence) and it names the actual word and gives the meaning in *this* context, which a static bilingual dictionary cannot.

So both the bundled dictionary and the segmenter fall out. What replaces them is a primitive already in the app: **the selection is the universal unit, the capture-unit and the gloss-unit at once.** Three properties make that hold without a segmenter:

```txt
human draws the boundary   (selection)      no algorithm has to guess word edges
model is contextual        (gloss source)   tolerates a sloppy span, finds the word itself
deletion is cheap          (commit 5d7f84c1e)  a wrong capture is one tap to undo
```

This is the same trade the rest of the spec keeps making: reversibility over upfront-correctness machinery. Segmentation is upfront correctness; human boundary + forgiving model + cheap undo is the reversible version.

**What step 7 becomes (two surfaces, both half-built):**

- *Tracked words*: `highlight.ts` already wraps them in `<span>`s with an exact boundary (they are dictionary entries). Make the span tappable for a contextual model gloss in a popover. No new structure, a click handler and a popover.
- *Untracked text*: the step-6 selection toolbar already floats on a selection with one "Add" button. Add a second action, "What's this?", that glosses the selection with the model. Same gesture, one more button. The model also soft-validates: select 中国人 sloppily and it can answer "that is 中国 plus 人."

**How much it collapses:**

```txt
step 7 as drawn                      step 7 collapsed
─────────────────────────────       ──────────────────────────────
CC-CEDICT (2-4MB, CC-BY-SA)    ->    deleted (model glosses, contextually)
a segmenter / Intl.Segmenter   ->    deleted (selection is the boundary)
tap-to-add via segmentation    ->    already shipped (step 6 selection)
tap-to-gloss                   ->    tappable spans + one toolbar button
offline gloss                  ->    moot (the chat is online by nature)
size / license gate            ->    gone
```

The one honest cost is single-tap-to-add ergonomics: every untracked capture stays a drag-select. Two things soften it. Browsers already snap selection to a CJK word for free using their own ICU segmenter (double-click on desktop, long-press on touch), so "tap a word" is largely a platform affordance we do not ship. And the toolbar shows the boundary before you commit, so over-selection is caught in the moment.

**Refusals (moved here from step 7's scope, with triggers):**

| Candidate | Refusal | User loss | Trigger to revisit |
| --- | --- | --- | --- |
| CC-CEDICT bundled dictionary | The model is the gloss source and gives the meaning *in context*, which a static dictionary cannot; its offline/exact virtue is moot because the chat is online by nature. Deletes a 2-4MB CC-BY-SA asset, a parser, and the license gate | No offline gloss; no instant local lookup (mitigate: pinyin-pro renders the reading instantly, the meaning streams after; cache looked-up glosses) | You want exact, offline, deterministic gloss across the whole list and will pay the bundle and the license |
| A segmenter (CC-CEDICT-backed or `Intl.Segmenter`) | All three consumers are covered without it: capture by selection, highlight by personal-list longest-match, gloss by a boundary-agnostic model. Selection is the capture- and gloss-unit | Single-tap-add (drag-select instead), softened by browser-native word selection | Single-tap-add ergonomics feel missing; then `Intl.Segmenter` is the native, zero-asset way to add it as polish |

Deferred, with triggers:

- **Gloss caching / persistence.** The first version can call the model per tap. If repeat taps feel slow or wasteful, cache `word -> gloss` in memory or persist a tiny gloss field. Trigger: re-glossing the same word feels redundant.
- **Pronunciation (STT/TTS/tone).** Unchanged from the research subpage; a later rung, never gating the core loop.

### Step 7 as built: one WordPopover for capture and gloss (2026-06-14)

The collapse above shipped, and it collapsed further in the build than the plan drew. What landed:

- **Gloss is the model, out-of-band.** `streamGloss` (`apps/zhongwen/src/lib/gloss.ts`) hits the plain `/api/ai/chat` SSE route, never `chatDoc`, so a gloss never writes to the transcript doc and never reaches the reflection roster. It hand-parses the TanStack AI SSE frames (`TEXT_MESSAGE_CONTENT` deltas) rather than pulling `@tanstack/ai-svelte` for one tooltip; the trigger to replace it with `fetchServerSentEvents` is zhongwen adopting `createChat` anywhere. Glosses are cached by word + context for the session, so retaps are instant with no model call.
- **Segmentation stayed refused.** No `Intl.Segmenter`, no dictionary. Boundaries come from the lens spans (tracked words) and from free selection (anything else).
- **The capture toolbar and the gloss card collapsed into one component.** The plan kept a `SelectionCapture` toolbar and a separate gloss card; the build merged them into `WordPopover` (`.../components/WordPopover.svelte`), one anchored surface with two phases: `actions` ([Add] [What's this?], shown for a fresh selection) and `meaning` (the reading via pinyin-pro, instant, plus the streamed contextual meaning). A tap on a lens-highlighted word opens straight in `meaning`; a selection opens in `actions` and "What's this?" walks it to `meaning`. The phase is owned by `ConversationView` (single source of truth). Detection moved to a headless `SelectionSource`. This retired `SelectionCapture` and `GlossPopover` (both deleted), so the step-6 note above describes a file that no longer exists.
- **Context resolves once, by id.** Each bubble carries `data-message-id`; both entry points resolve the sentence from the live `messages` array (`contextFor`), so no message text is duplicated into the DOM and resolution is not split between the two paths.
- **The selection-preservation hack is gone.** `WordPopover` reads its text from props, not the live selection, so a button press collapsing the selection is harmless; the old `onpointerdown` preventDefault was deleted, not ported.
- **The lens runs over the learner's own messages too.** `AssistantMessagePart` generalized to `MessageContent` (both roles); user lines render literal (markdown off) but take the same highlight + tap-to-gloss path, so production (a word the learner typed) is painted and tappable.

Deferred, with triggers:

- **Re-add reschedule from chat.** Selecting a word you already have still just toasts; bump/reset (the bulk-import affordance) could surface in the popover's actions phase. Trigger: re-capturing a known word to reschedule feels wanted.
- **Single-tap-add via segmentation.** Still refused; `Intl.Segmenter` is the native, zero-asset way in if drag-select ergonomics chafe.
- **Gloss persistence.** The cache is session-lived and in-memory; persist a `word -> gloss` field only if cross-session reuse is wanted. Trigger: glossing the same words every session feels wasteful.
- **Verification.** The interaction (two-phase popover, tap-vs-drag disjointness, the hack removal) is typed and reasoned, not yet driven in a browser.

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
  mastery = self-reported comfort on one ordered ladder (New/Learning/Known);
    not a Leitner box (see the mastery-range refusal and the one-ladder section)
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

The loop is defined by "Two roles per conversation: recognize vs use" in the Revision 2026-06-14 section above: one ordered comfort ladder (New, Learning, Known), where each in-play word is steered in one of two roles derived per conversation (the AI shows New words for recognition; the AI fishes for the learner to produce Learning words). The earlier Box 0-5 staircase is dropped, because self-report's honest ceiling is about three states, not five (see the mastery-range refusal). Capture (highlight-to-add) and grading (the reflection moment) write back; STT/TTS adds a pronunciation rung (see research).

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
