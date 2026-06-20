/**
 * Tests for `attachChatBrowserAnswerer`: the in-process (browser) trigger
 * wrapper. Unlike `chat-worker.test.ts`, which drives `onChange` by hand, this
 * suite proves the self-wiring: the answerer observes the transcript itself, so a
 * plain `appendUser` (the optimistic echo a browser tab writes) is enough to make
 * it claim, stream, and finish, with no manual nudge. The claim path it runs is
 * `attachChatWorker`'s, so the existence-based `findUnansweredTurn` claim is
 * covered there; here we cover the wiring and teardown.
 */

import { describe, expect, test } from 'bun:test';
import { EventType, type StreamChunk } from '@tanstack/ai';
import * as Y from 'yjs';
import type { ChatStream } from './chat-answer.js';
import { attachChatBrowserAnswerer } from './chat-browser-answerer.js';
import { attachChatTranscript } from './chat-doc.js';

function textChunk(delta: string): StreamChunk {
	return {
		type: EventType.TEXT_MESSAGE_CONTENT,
		messageId: 'message-1',
		delta,
	} as StreamChunk;
}

/** A `ChatStream` that yields the given deltas, then ends. */
function streamOf(...deltas: string[]): ChatStream {
	return async function* () {
		for (const delta of deltas) yield textChunk(delta);
	};
}

/** Drain pending microtasks so an in-flight async stream settles. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('attachChatBrowserAnswerer', () => {
	test('answers a user turn from the optimistic echo alone (no manual nudge)', async () => {
		const doc = new Y.Doc({ guid: 'browser-answerer-test' });
		const transcript = attachChatTranscript(doc);
		const stop = attachChatBrowserAnswerer({
			doc,
			startStream: streamOf('hello ', 'world'),
		});

		// The browser writes the user turn locally; the observer wakes the answerer.
		transcript.appendUser({
			id: 'u1',
			content: 'hi',
			createdAt: 1,
			generationId: 'gen-1',
		});
		await tick();

		const messages = transcript.read();
		expect(messages).toHaveLength(2);
		expect(messages[1]).toMatchObject({
			id: 'gen-1',
			role: 'assistant',
			text: 'hello world',
			finish: { kind: 'completed' },
		});
		stop();
		doc.destroy();
	});

	test('reconciles a turn already pending when the answerer attaches', async () => {
		const doc = new Y.Doc({ guid: 'browser-answerer-pending' });
		const transcript = attachChatTranscript(doc);
		// The turn exists before the answerer is wired (e.g. this tab reopened
		// mid-conversation, or it synced from another device).
		transcript.appendUser({
			id: 'u1',
			content: 'hi',
			createdAt: 1,
			generationId: 'gen-1',
		});

		const stop = attachChatBrowserAnswerer({
			doc,
			startStream: streamOf('answer'),
		});
		await tick();

		expect(transcript.read().at(-1)).toMatchObject({
			id: 'gen-1',
			role: 'assistant',
			text: 'answer',
			finish: { kind: 'completed' },
		});
		stop();
		doc.destroy();
	});

	test('stop() unobserves: a later turn is not answered', async () => {
		const doc = new Y.Doc({ guid: 'browser-answerer-stop' });
		const transcript = attachChatTranscript(doc);
		const stop = attachChatBrowserAnswerer({
			doc,
			startStream: streamOf('answer'),
		});
		stop();

		transcript.appendUser({
			id: 'u1',
			content: 'hi',
			createdAt: 1,
			generationId: 'gen-1',
		});
		await tick();

		// No assistant message: the answerer is detached.
		expect(transcript.read()).toHaveLength(1);
		doc.destroy();
	});
});
