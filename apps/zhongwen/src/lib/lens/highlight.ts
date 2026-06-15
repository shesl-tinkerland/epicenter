/**
 * The vocab-highlight channel of the lens: paint the learner's dictionary onto
 * an assistant message. Words they are still learning pop; words they already
 * know fade back. This generalizes the same render-time overlay `annotateHtml`
 * does for pinyin, and composes with it: highlight first, then pinyin annotates
 * the text inside each highlight span.
 */

import type { Vocabulary } from '@epicenter/zhongwen';
import { findVocabMatches } from './match';

/**
 * Tailwind classes for a matched word, keyed by self-reported comfort. New and
 * Learning words get a colored underline so they read as "still working on
 * these"; Known words fade, since the lens's job is to draw the eye to what is
 * not yet retired.
 */
function masteryClass(mastery: Vocabulary['mastery']): string {
	switch (mastery) {
		case 0:
			return 'underline decoration-2 decoration-sky-500 underline-offset-4';
		case 1:
			return 'underline decoration-2 decoration-amber-500 underline-offset-4';
		default:
			return 'text-muted-foreground/60';
	}
}

/**
 * Wrap every dictionary word inside the text nodes of `html` in a styled span.
 * Splits by tags (odd indices are tags, even are text) so tag names and
 * attributes are never touched, mirroring `annotateHtml`. The text nodes are
 * already HTML-escaped by `marked`, and vocabulary terms are CJK, so matched
 * runs need no further escaping.
 */
export function highlightVocabHtml(html: string, words: Vocabulary[]): string {
	if (words.length === 0) return html;

	const parts = html.split(/(<[^>]*>)/);
	for (let i = 0; i < parts.length; i += 2) {
		const text = parts[i];
		if (!text) continue;
		parts[i] = findVocabMatches(text, words)
			.map((segment) =>
				segment.kind === 'match'
					? `<span class="${masteryClass(segment.word.mastery)}">${segment.text}</span>`
					: segment.text,
			)
			.join('');
	}
	return parts.join('');
}
