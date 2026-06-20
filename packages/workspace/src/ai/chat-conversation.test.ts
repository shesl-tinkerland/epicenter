/**
 * Tests for `attachChatConversation`: the conversation controller folded onto the
 * transcript handle. `chat-browser-answerer.test.ts` covers the claim/stream
 * wiring; here we cover the controller sugar the handle adds — `send` mints a turn
 * the in-process `answer` claims, `status` projects the snapshot into render state,
 * and the answerer's stop detaches it.
 */

import { describe, expect, test } from 'bun:test';
import { EventType, type StreamChunk } from '@tanstack/ai';
import * as Y from 'yjs';
import type { ChatStream } from './chat-answer.js';
import { attachChatConversation } from './chat-conversation.js';

function textChunk(delta: string): StreamChunk {
	return {
		type: EventType.TEXT_MESSAGE_CONTENT,
		messageId: 'm1',
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

describe('attachChatConversation', () => {
	test('send mints a turn the in-process answer claims and streams', async () => {
		const doc = new Y.Doc({ guid: 'chat-conversation-send' });
		const convo = attachChatConversation(doc);
		convo.answer(streamOf('hello ', 'world'));

		// `send` mints the user turn's id and the generationId the answer awaits.
		convo.send('hi');
		await tick();

		const messages = convo.read();
		expect(messages).toHaveLength(2);
		expect(messages[0]).toMatchObject({ role: 'user', text: 'hi' });
		expect(messages[1]).toMatchObject({
			role: 'assistant',
			text: 'hello world',
			finish: { kind: 'completed' },
		});

		// A settled conversation projects to `ready`, both turns visible.
		const render = convo.status(Date.now());
		expect(render.status).toBe('ready');
		expect(render.isGenerating).toBe(false);
		expect(render.visibleMessages).toHaveLength(2);

		doc.destroy();
	});

	test('send is a no-op on empty input', () => {
		const doc = new Y.Doc({ guid: 'chat-conversation-empty' });
		const convo = attachChatConversation(doc);
		convo.send('   ');
		expect(convo.read()).toHaveLength(0);
		doc.destroy();
	});

	test('the answerer stop detaches: a later turn is not answered', async () => {
		const doc = new Y.Doc({ guid: 'chat-conversation-stop' });
		const convo = attachChatConversation(doc);
		const stop = convo.answer(streamOf('answer'));
		stop();

		convo.send('hi');
		await tick();

		// User turn only: the answerer was detached before the turn landed.
		expect(convo.read()).toHaveLength(1);
		doc.destroy();
	});
});
