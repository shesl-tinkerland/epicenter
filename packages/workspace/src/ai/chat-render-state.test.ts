/**
 * Tests for `chatRenderState`: the pure doc -> render-state projection every
 * render-from-doc client shares. Messages are built as plain `ChatDocMessage`
 * snapshots (what `readChatDocMessages` returns), so these cases pin the
 * liveness/status rules without a live `Y.Doc`.
 */

import { describe, expect, test } from 'bun:test';
import type { ChatDocFinish, ChatDocMessage } from './chat-doc.js';
import { CHAT_STREAM_GRACE_MS, chatRenderState } from './chat-render-state.js';

const NOW = 1_000_000;

function user(text: string): ChatDocMessage {
	return {
		id: `u-${text}`,
		role: 'user',
		createdAt: NOW,
		parts: [{ type: 'text', content: text }],
		text,
		generationId: `gen-${text}`,
	};
}

function assistant(
	text: string,
	{
		createdAt = NOW,
		finish,
	}: { createdAt?: number; finish?: ChatDocFinish } = {},
): ChatDocMessage {
	return {
		id: 'a1',
		role: 'assistant',
		createdAt,
		parts: text ? [{ type: 'text', content: text }] : [],
		text,
		...(finish !== undefined && { finish }),
	};
}

const clock = { now: NOW, lastChangeAt: NOW };

describe('chatRenderState', () => {
	test('empty transcript is ready and idle', () => {
		const state = chatRenderState([], clock);
		expect(state.status).toBe('ready');
		expect(state.isGenerating).toBe(false);
		expect(state.visibleMessages).toEqual([]);
	});

	test('an external trigger with no claim yet is thinking (submitted)', () => {
		const state = chatRenderState([user('hi')], {
			...clock,
			externallyGenerating: true,
		});
		expect(state.isGenerating).toBe(true);
		expect(state.isThinking).toBe(true);
		expect(state.status).toBe('submitted');
	});

	test('a claimed but empty assistant turn is thinking (submitted)', () => {
		const state = chatRenderState([user('hi'), assistant('')], clock);
		expect(state.isGenerating).toBe(true);
		expect(state.isThinking).toBe(true);
		expect(state.status).toBe('submitted');
		// The empty placeholder is not painted; the typing bubble stands in.
		expect(state.visibleMessages).toHaveLength(1);
		expect(state.visibleMessages[0]?.role).toBe('user');
	});

	test('an assistant turn with text is streaming', () => {
		const state = chatRenderState([user('hi'), assistant('你好')], clock);
		expect(state.status).toBe('streaming');
		expect(state.isThinking).toBe(false);
		expect(state.visibleMessages).toHaveLength(2);
	});

	test('a completed turn is ready, not generating, not interrupted', () => {
		const state = chatRenderState(
			[user('hi'), assistant('你好', { finish: { kind: 'completed' } })],
			clock,
		);
		expect(state.status).toBe('ready');
		expect(state.isGenerating).toBe(false);
		expect(state.isInterrupted).toBe(false);
	});

	test('a failed turn surfaces the failure as an error', () => {
		const failure = {
			kind: 'failed',
			code: 'InsufficientCredits',
			message: 'nope',
		} as const;
		const state = chatRenderState(
			[user('hi'), assistant('', { finish: failure })],
			clock,
		);
		expect(state.status).toBe('error');
		expect(state.failure).toEqual(failure);
	});

	test('an unfinished assistant past the active window is interrupted', () => {
		// createdAt far in the past: findActiveChatDocGeneration drops it, and the
		// grace window has long lapsed, so it is no longer live.
		const stale = assistant('partial', { createdAt: NOW - 5 * 60 * 1000 });
		const state = chatRenderState([user('hi'), stale], {
			now: NOW,
			lastChangeAt: NOW - 5 * 60 * 1000,
		});
		expect(state.isGenerating).toBe(false);
		expect(state.isInterrupted).toBe(true);
		expect(state.status).toBe('ready');
	});

	test('a live generation whose updates stalled past the grace window stops being live', () => {
		// Recent createdAt (inside the active window) but no doc change for longer
		// than the grace window: the stream stalled, so it is no longer generating.
		const state = chatRenderState([user('hi'), assistant('partial')], {
			now: NOW,
			lastChangeAt: NOW - (CHAT_STREAM_GRACE_MS + 1),
		});
		expect(state.isGenerating).toBe(false);
		expect(state.isInterrupted).toBe(true);
	});
});
