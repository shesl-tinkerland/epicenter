/**
 * The review queue: a pure selector over the vocabulary table, not a screen and
 * not a stored list.
 *
 * There is no flashcard surface and no spaced-repetition interval. The
 * conversation IS the repetition: a word the user is working on gets woven into
 * every conversation until they self-report it Known on the Words screen. So the
 * queue's only job is to pick which words a conversation should weave in today,
 * and its only consumer is the conversation system prompt
 * (`buildVocabularySystemPrompt`).
 *
 * See the 2026-06-14 revision of
 * `specs/20260614T022000-vocab-two-boats-conversation-and-dictionary.md`.
 */

import type { CalendarDateString } from '@epicenter/field';
import type { Vocabulary } from '@epicenter/zhongwen';

/**
 * The words "in play" for conversations on `today`.
 *
 * A word is in play when it is not yet retired (`mastery < 2`, i.e. New or
 * Learning) and its review day has arrived (`dueAt <= today`; `dueAt` is a
 * snooze/nudge handle, not an auto-advancing schedule). Learning words all
 * return, because the point is to keep reusing them in conversation until the
 * user marks them Known. New words are throttled to `newWordsPerDay` so a bulk
 * import of hundreds of words does not flood every conversation; self-reporting
 * a new word up to Learning is what rotates the next new word into the queue.
 *
 * Ordered oldest-first by `createdAt` (the same order the Words list and a bulk
 * paste read in), so the queue is stable and the first-added words surface
 * first. Learning words lead, then the new trickle.
 */
export function reviewQueue(
	words: Vocabulary[],
	{
		today,
		newWordsPerDay,
	}: { today: CalendarDateString; newWordsPerDay: number },
): Vocabulary[] {
	const inPlay = words
		.filter((word) => word.mastery < 2 && word.dueAt <= today)
		.sort((a, b) => a.createdAt.localeCompare(b.createdAt));

	const learning = inPlay.filter((word) => word.mastery === 1);
	const newWords = inPlay
		.filter((word) => word.mastery === 0)
		.slice(0, newWordsPerDay);

	return [...learning, ...newWords];
}
