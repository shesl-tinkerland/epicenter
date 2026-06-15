/**
 * The reflection roster: given a finished conversation's transcript, work out
 * which of the learner's dictionary words actually showed up, split into the
 * three relationships a learner has to a word in a chat.
 *
 * This is the payoff of building the matcher (`findVocabMatches`) before the
 * reflection screen: the roster is the matcher run over the real transcript,
 * the AI's lines and the learner's, instead of the in-play approximation the
 * system prompt steers with. It is a pure selector (no doc reads, no writes) so
 * the reflection sheet just renders it and bumps comfort through the same
 * self-report control the Words screen owns.
 *
 * See "The reflection grading moment" in
 * `specs/20260614T022000-vocab-two-boats-conversation-and-dictionary.md`.
 */

import type { ChatDocMessage } from '@epicenter/workspace/ai';
import type { Vocabulary } from '@epicenter/zhongwen';
import { findVocabMatches } from './lens/match';

/**
 * The three relationships, mutually exclusive:
 *
 * - `used`: words that appeared in the learner's own messages. The strongest
 *   signal (production), so a word the learner used wins this bucket even if the
 *   AI also said it.
 * - `met`: words that appeared only in the AI's messages. The learner
 *   encountered them but did not produce them.
 * - `missed`: words that were in play for today (the steering targets) but never
 *   surfaced on either side. The conversation did not get to them.
 */
export type ReflectionRoster = {
	used: Vocabulary[];
	met: Vocabulary[];
	missed: Vocabulary[];
};

/**
 * Build the roster from the transcript. `words` is the full dictionary (used to
 * detect any tracked word that appeared); `inPlay` is today's steering targets
 * (`reviewQueue`), the only candidates for the `missed` bucket. Bucket order
 * follows the input arrays, so pass `words` pre-sorted for a stable display.
 */
export function reflectionRoster({
	messages,
	words,
	inPlay,
}: {
	messages: ChatDocMessage[];
	words: Vocabulary[];
	inPlay: Vocabulary[];
}): ReflectionRoster {
	const usedIds = matchedIds(messages, 'user', words);
	const metIds = matchedIds(messages, 'assistant', words);

	return {
		used: words.filter((word) => usedIds.has(word.id)),
		met: words.filter((word) => metIds.has(word.id) && !usedIds.has(word.id)),
		missed: inPlay.filter(
			(word) => !usedIds.has(word.id) && !metIds.has(word.id),
		),
	};
}

/** The ids of dictionary words that appear in any message from `role`. */
function matchedIds(
	messages: ChatDocMessage[],
	role: ChatDocMessage['role'],
	words: Vocabulary[],
): Set<Vocabulary['id']> {
	const ids = new Set<Vocabulary['id']>();
	for (const message of messages) {
		if (message.role !== role) continue;
		// Match per message, never on a concatenation, so two messages cannot join
		// across their boundary into a word that was not really written.
		for (const segment of findVocabMatches(message.text, words)) {
			if (segment.kind === 'match') ids.add(segment.word.id);
		}
	}
	return ids;
}
