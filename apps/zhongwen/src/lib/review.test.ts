import { describe, expect, test } from 'bun:test';
import type { CalendarDateString, InstantString } from '@epicenter/field';
import type { TermId, Vocabulary } from '@epicenter/zhongwen';
import { reviewQueue } from './review';

const TODAY = '2026-06-14' as CalendarDateString;
const at = (iso: string) => iso as InstantString;

/** Build a vocabulary row; createdAt defaults to a per-call counter so order is stable. */
let seq = 0;
function word(partial: Partial<Vocabulary> = {}): Vocabulary {
	seq += 1;
	return {
		id: `term-${seq}` as TermId,
		text: `word-${seq}`,
		mastery: 0,
		dueAt: TODAY,
		// Pad so plain string sort matches insertion order past 9 rows.
		createdAt: at(`2026-06-14T00:00:${String(seq).padStart(2, '0')}.000Z`),
		...partial,
	} as Vocabulary;
}

describe('reviewQueue', () => {
	test('retires Known words (mastery 2)', () => {
		const queue = reviewQueue([word({ mastery: 2 })], {
			today: TODAY,
			newWordsPerDay: 10,
		});
		expect(queue).toHaveLength(0);
	});

	test('keeps every due Learning word, no cap', () => {
		const learning = Array.from({ length: 25 }, () => word({ mastery: 1 }));
		const queue = reviewQueue(learning, { today: TODAY, newWordsPerDay: 10 });
		expect(queue).toHaveLength(25);
		expect(queue.every((w) => w.mastery === 1)).toBe(true);
	});

	test('throttles New words to newWordsPerDay', () => {
		const fresh = Array.from({ length: 50 }, () => word({ mastery: 0 }));
		const queue = reviewQueue(fresh, { today: TODAY, newWordsPerDay: 10 });
		expect(queue).toHaveLength(10);
		expect(queue.every((w) => w.mastery === 0)).toBe(true);
	});

	test('the New throttle is oldest-first', () => {
		const fresh = [
			word({ mastery: 0, createdAt: at('2026-06-14T00:00:09.000Z') }),
			word({ mastery: 0, createdAt: at('2026-06-14T00:00:08.000Z') }),
			word({
				mastery: 0,
				text: 'first',
				createdAt: at('2026-06-14T00:00:00.000Z'),
			}),
		];
		const queue = reviewQueue(fresh, { today: TODAY, newWordsPerDay: 1 });
		expect(queue).toHaveLength(1);
		expect(queue[0]?.text).toBe('first');
	});

	test('excludes words snoozed into the future (dueAt > today)', () => {
		const queue = reviewQueue(
			[
				word({ mastery: 1, dueAt: '2026-06-20' as CalendarDateString }),
				word({ mastery: 1, dueAt: TODAY }),
			],
			{ today: TODAY, newWordsPerDay: 10 },
		);
		expect(queue).toHaveLength(1);
	});

	test('includes words due in the past', () => {
		const queue = reviewQueue(
			[word({ mastery: 1, dueAt: '2026-06-01' as CalendarDateString })],
			{ today: TODAY, newWordsPerDay: 10 },
		);
		expect(queue).toHaveLength(1);
	});

	test('Learning words lead, then the new trickle', () => {
		const queue = reviewQueue(
			[
				word({ mastery: 0, text: 'new-a' }),
				word({ mastery: 1, text: 'learn-a' }),
				word({ mastery: 0, text: 'new-b' }),
			],
			{ today: TODAY, newWordsPerDay: 10 },
		);
		expect(queue.map((w) => w.text)).toEqual(['learn-a', 'new-a', 'new-b']);
	});
});
