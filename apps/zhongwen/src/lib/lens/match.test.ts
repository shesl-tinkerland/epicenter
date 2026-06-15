import { describe, expect, test } from 'bun:test';
import type { CalendarDateString, InstantString } from '@epicenter/field';
import type { TermId, Vocabulary } from '@epicenter/zhongwen';
import { findVocabMatches, type VocabSegment } from './match';

let seq = 0;
function word(text: string, partial: Partial<Vocabulary> = {}): Vocabulary {
	seq += 1;
	return {
		id: `term-${seq}` as TermId,
		text,
		mastery: 0,
		dueAt: '2026-06-14' as CalendarDateString,
		createdAt: '2026-06-14T00:00:00.000Z' as InstantString,
		...partial,
	} as Vocabulary;
}

const matched = (segments: VocabSegment[]) =>
	segments.filter((segment) => segment.kind === 'match');

describe('findVocabMatches', () => {
	test('empty text yields no segments', () => {
		expect(findVocabMatches('', [word('拿铁')])).toEqual([]);
	});

	test('no words leaves the text whole', () => {
		expect(findVocabMatches('你好世界', [])).toEqual([
			{ kind: 'text', text: '你好世界' },
		]);
	});

	test('wraps a word and keeps the surrounding text', () => {
		const segments = findVocabMatches('我要拿铁谢谢', [word('拿铁')]);
		expect(segments).toHaveLength(3);
		expect(segments[1]).toMatchObject({ kind: 'match', text: '拿铁' });
	});

	test('prefers the longest word at a position', () => {
		const segments = findVocabMatches('我学中文', [word('中'), word('中文')]);
		expect(matched(segments)).toHaveLength(1);
		expect(matched(segments)[0]?.text).toBe('中文');
	});

	test('finds adjacent words', () => {
		const segments = findVocabMatches('推荐预订', [word('推荐'), word('预订')]);
		expect(matched(segments).map((segment) => segment.text)).toEqual([
			'推荐',
			'预订',
		]);
	});

	test('carries the matched word through so the caller can color it', () => {
		const segments = findVocabMatches('拿铁', [word('拿铁', { mastery: 2 })]);
		const [first] = matched(segments);
		expect(first?.kind === 'match' && first.word.mastery).toBe(2);
	});

	test('reconstructs the input losslessly', () => {
		const text = '今天我想喝一杯拿铁，然后预订一个房间。';
		const segments = findVocabMatches(text, [
			word('拿铁'),
			word('预订'),
			word('房间'),
		]);
		expect(segments.map((segment) => segment.text).join('')).toBe(text);
	});
});
