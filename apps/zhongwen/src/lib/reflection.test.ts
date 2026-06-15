import { describe, expect, test } from 'bun:test';
import type { CalendarDateString, InstantString } from '@epicenter/field';
import type { ChatDocMessage } from '@epicenter/workspace/ai';
import type { TermId, Vocabulary } from '@epicenter/zhongwen';
import { reflectionRoster } from './reflection';

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

let msgSeq = 0;
function message(role: ChatDocMessage['role'], text: string): ChatDocMessage {
	msgSeq += 1;
	return { id: `msg-${msgSeq}`, role, text, createdAt: 0 };
}

const texts = (words: Vocabulary[]) => words.map((word) => word.text);

describe('reflectionRoster', () => {
	test('a word the learner wrote lands in used', () => {
		const latte = word('拿铁');
		const roster = reflectionRoster({
			messages: [message('user', '我要一杯拿铁')],
			words: [latte],
			inPlay: [latte],
		});
		expect(texts(roster.used)).toEqual(['拿铁']);
		expect(roster.met).toEqual([]);
		expect(roster.missed).toEqual([]);
	});

	test('a word only the AI wrote lands in met', () => {
		const latte = word('拿铁');
		const roster = reflectionRoster({
			messages: [message('assistant', '这家店的拿铁很好喝')],
			words: [latte],
			inPlay: [latte],
		});
		expect(roster.used).toEqual([]);
		expect(texts(roster.met)).toEqual(['拿铁']);
		expect(roster.missed).toEqual([]);
	});

	test('used wins when both sides wrote the word', () => {
		const latte = word('拿铁');
		const roster = reflectionRoster({
			messages: [
				message('assistant', '你想喝拿铁吗'),
				message('user', '我要拿铁'),
			],
			words: [latte],
			inPlay: [latte],
		});
		expect(texts(roster.used)).toEqual(['拿铁']);
		expect(roster.met).toEqual([]);
	});

	test('an in-play word that never surfaced lands in missed', () => {
		const latte = word('拿铁');
		const booking = word('预订');
		const roster = reflectionRoster({
			messages: [message('user', '我要拿铁')],
			words: [latte, booking],
			inPlay: [latte, booking],
		});
		expect(texts(roster.used)).toEqual(['拿铁']);
		expect(texts(roster.missed)).toEqual(['预订']);
	});

	test('missed is scoped to in-play, not the whole dictionary', () => {
		const latte = word('拿铁');
		const offlist = word('房间'); // tracked but not steered today
		const roster = reflectionRoster({
			messages: [message('user', '你好')],
			words: [latte, offlist],
			inPlay: [latte],
		});
		// 房间 is not in play, so its absence is not a "missed" of this chat.
		expect(texts(roster.missed)).toEqual(['拿铁']);
	});

	test('words that did appear but are off the steering list still bucket by side', () => {
		const offlist = word('房间');
		const roster = reflectionRoster({
			messages: [message('assistant', '我帮你订房间')],
			words: [offlist],
			inPlay: [],
		});
		expect(texts(roster.met)).toEqual(['房间']);
		expect(roster.missed).toEqual([]);
	});

	test('bucket order follows the input arrays', () => {
		const a = word('一');
		const b = word('二');
		const c = word('三');
		const roster = reflectionRoster({
			messages: [message('user', '三二一')],
			words: [a, b, c],
			inPlay: [a, b, c],
		});
		// All three were used; order mirrors `words`, not appearance order.
		expect(texts(roster.used)).toEqual(['一', '二', '三']);
	});
});
