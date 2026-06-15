/**
 * The vocab matcher: find which dictionary words appear in a stretch of Chinese
 * text. This is the reusable core of the lens. The live highlight overlay
 * (`highlightVocabHtml`) renders its output as colored spans, and the
 * post-conversation reflection roster will reuse it to ask "which of my words
 * actually showed up in this transcript" (the AI's lines and the learner's).
 *
 * Chinese has no spaces, so matching is dictionary-driven: at each position take
 * the longest vocabulary term that starts there. Greedy longest-first is the
 * standard segmentation heuristic and is good enough for a personal list.
 */

import type { Vocabulary } from '@epicenter/zhongwen';

/** One run of the input: either untracked text or a matched vocabulary word. */
export type VocabSegment =
	| { kind: 'text'; text: string }
	| { kind: 'match'; text: string; word: Vocabulary };

/**
 * Split `text` into an ordered list of segments, wrapping every occurrence of a
 * vocabulary word (longest match wins at each position). Plain stretches stay as
 * `text` segments, so a caller can rebuild the string losslessly:
 * `segments.map((s) => s.text).join('')` equals the input.
 */
export function findVocabMatches(
	text: string,
	words: Vocabulary[],
): VocabSegment[] {
	if (!text) return [];
	if (words.length === 0) return [{ kind: 'text', text }];

	// Look up a candidate term by its exact text, and know the longest term so we
	// only probe substrings that could possibly match.
	const byText = new Map(words.map((word) => [word.text, word]));
	let longest = 0;
	for (const word of words) {
		if (word.text.length > longest) longest = word.text.length;
	}

	const segments: VocabSegment[] = [];
	let pending = '';
	let i = 0;
	while (i < text.length) {
		const match = longestMatchAt(text, i, longest, byText);
		if (!match) {
			pending += text[i];
			i += 1;
			continue;
		}
		if (pending) {
			segments.push({ kind: 'text', text: pending });
			pending = '';
		}
		segments.push({ kind: 'match', text: match.text, word: match });
		i += match.text.length;
	}
	if (pending) segments.push({ kind: 'text', text: pending });
	return segments;
}

/** The longest vocabulary word that is a prefix of `text` at `start`, or null. */
function longestMatchAt(
	text: string,
	start: number,
	longest: number,
	byText: Map<string, Vocabulary>,
): Vocabulary | null {
	const maxLen = Math.min(longest, text.length - start);
	for (let len = maxLen; len >= 1; len -= 1) {
		const word = byText.get(text.slice(start, start + len));
		if (word) return word;
	}
	return null;
}
