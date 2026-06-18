/**
 * Tests for `attachChatTranscript`: the client-facing transcript layout handle.
 *
 * The free functions (`appendUserMessage`, `appendAssistantMessage`, ...) are
 * the implementation and the server's entry point; this suite covers the
 * boundary-respecting handle a UI binds to, and that it reads writes from the
 * server-side assistant writer (the two-writer contract holding through one doc).
 */

import { describe, expect, test } from 'bun:test';
import * as Y from 'yjs';
import {
	appendAssistantMessage,
	attachChatTranscript,
	type ChatDocMessage,
	findLatestUserTurn,
	findUnansweredTurn,
} from './chat-doc.js';

describe('attachChatTranscript', () => {
	test('appendUser then read returns the message in transcript order', () => {
		const doc = new Y.Doc({ guid: 'chat-test' });
		const transcript = attachChatTranscript(doc);

		transcript.appendUser({
			id: 'm1',
			content: 'hello',
			createdAt: 1,
			generationId: 'g1',
		});
		transcript.appendUser({
			id: 'm2',
			content: 'world',
			createdAt: 2,
			generationId: 'g2',
		});

		const messages = transcript.read();
		expect(
			messages.map((m) => ({ id: m.id, role: m.role, text: m.text })),
		).toEqual([
			{ id: 'm1', role: 'user', text: 'hello' },
			{ id: 'm2', role: 'user', text: 'world' },
		]);
		doc.destroy();
	});

	test('observe fires on a write and re-read reflects it', () => {
		const doc = new Y.Doc({ guid: 'chat-observe' });
		const transcript = attachChatTranscript(doc);

		let fired = 0;
		const unobserve = transcript.observe(() => {
			fired++;
		});
		transcript.appendUser({
			id: 'm1',
			content: 'hi',
			createdAt: 1,
			generationId: 'g1',
		});

		expect(fired).toBeGreaterThan(0);
		expect(transcript.read()).toHaveLength(1);

		unobserve();
		transcript.appendUser({
			id: 'm2',
			content: 'bye',
			createdAt: 2,
			generationId: 'g2',
		});
		// No further callbacks after unobserve, but the write still lands.
		expect(fired).toBe(1);
		expect(transcript.read()).toHaveLength(2);
		doc.destroy();
	});

	test('reads assistant messages written by the server-side writer', () => {
		const doc = new Y.Doc({ guid: 'chat-assistant' });
		const transcript = attachChatTranscript(doc);

		transcript.appendUser({
			id: 'u1',
			content: 'ask',
			createdAt: 1,
			generationId: 'a1',
		});
		// The server generation actor writes assistant messages via the free
		// function; the client handle reads them through the same doc.
		const writer = appendAssistantMessage(doc, { id: 'a1', createdAt: 2 });
		writer.appendText('answer');
		writer.finish({ kind: 'completed' });

		const messages = transcript.read();
		expect(messages.map((m) => m.role)).toEqual(['user', 'assistant']);
		expect(messages[1]?.text).toBe('answer');
		expect(messages[1]?.finish).toEqual({ kind: 'completed' });
		doc.destroy();
	});

	test('the user turn carries its generationId; the latest turn names the work', () => {
		const doc = new Y.Doc({ guid: 'chat-generation-id' });
		const transcript = attachChatTranscript(doc);

		transcript.appendUser({
			id: 'u1',
			content: 'ask',
			createdAt: 1,
			generationId: 'gen-1',
		});

		expect(transcript.read()[0]?.generationId).toBe('gen-1');
		expect(findLatestUserTurn(transcript.read())?.generationId).toBe('gen-1');
		doc.destroy();
	});

	test('remintGeneration re-points the latest user turn for a retry', () => {
		const doc = new Y.Doc({ guid: 'chat-remint' });
		const transcript = attachChatTranscript(doc);

		transcript.appendUser({
			id: 'u1',
			content: 'ask',
			createdAt: 1,
			generationId: 'gen-1',
		});
		// A failed answer is keyed to the old id; the retry re-points the turn.
		const writer = appendAssistantMessage(doc, { id: 'gen-1', createdAt: 2 });
		writer.finish({ kind: 'failed', code: 'x', message: 'boom' });

		expect(transcript.remintGeneration('gen-2')).toBe('gen-2');
		expect(findLatestUserTurn(transcript.read())?.generationId).toBe('gen-2');
		// The id used for keying is untouched; only the generationId moved.
		expect(transcript.read()[0]?.id).toBe('u1');
		doc.destroy();
	});

	test('remintGeneration with no user turn returns undefined', () => {
		const doc = new Y.Doc({ guid: 'chat-remint-empty' });
		const transcript = attachChatTranscript(doc);

		expect(transcript.remintGeneration('gen-1')).toBeUndefined();
		doc.destroy();
	});

	test('requestCancel stamps cancelRequestedAt on the latest user turn', () => {
		const doc = new Y.Doc({ guid: 'chat-cancel' });
		const transcript = attachChatTranscript(doc);

		transcript.appendUser({
			id: 'u1',
			content: 'ask',
			createdAt: 1,
			generationId: 'gen-1',
		});

		expect(transcript.requestCancel(42)).toBe(42);
		expect(transcript.read()[0]?.cancelRequestedAt).toBe(42);
		doc.destroy();
	});

	test('requestCancel with no user turn returns undefined', () => {
		const doc = new Y.Doc({ guid: 'chat-cancel-empty' });
		const transcript = attachChatTranscript(doc);

		expect(transcript.requestCancel(42)).toBeUndefined();
		doc.destroy();
	});

	test('remintGeneration clears a stale cancel so the retry is not born cancelled', () => {
		const doc = new Y.Doc({ guid: 'chat-cancel-remint' });
		const transcript = attachChatTranscript(doc);

		transcript.appendUser({
			id: 'u1',
			content: 'ask',
			createdAt: 1,
			generationId: 'gen-1',
		});
		transcript.requestCancel(42);
		// A cancelled answer is keyed to the old id; the retry re-points the turn.
		appendAssistantMessage(doc, { id: 'gen-1', createdAt: 2 }).finish({
			kind: 'cancelled',
		});

		expect(transcript.remintGeneration('gen-2')).toBe('gen-2');
		expect(transcript.read()[0]?.cancelRequestedAt).toBeUndefined();
		expect(transcript.read()[0]?.generationId).toBe('gen-2');
		doc.destroy();
	});
});

describe('findUnansweredTurn', () => {
	const now = 1_000;
	const userTurn = (
		overrides: Partial<ChatDocMessage> = {},
	): ChatDocMessage => ({
		id: 'u1',
		role: 'user',
		createdAt: now,
		text: 'ask',
		generationId: 'gen-1',
		...overrides,
	});

	test('returns the latest user turn when nothing has answered it', () => {
		const turn = findUnansweredTurn([userTurn()], now);
		expect(turn?.generationId).toBe('gen-1');
	});

	test('returns undefined when there is no user turn', () => {
		expect(findUnansweredTurn([], now)).toBeUndefined();
	});

	test('returns undefined when the user turn carries no generationId', () => {
		expect(
			findUnansweredTurn([userTurn({ generationId: undefined })], now),
		).toBeUndefined();
	});

	test('returns undefined once a message is keyed to the generationId (claimed)', () => {
		const claimed: ChatDocMessage = {
			id: 'gen-1',
			role: 'assistant',
			createdAt: now,
			text: '',
		};
		expect(findUnansweredTurn([userTurn(), claimed], now)).toBeUndefined();
	});

	test('returns undefined while a recent unfinished assistant turn is still live', () => {
		const live: ChatDocMessage = {
			id: 'other',
			role: 'assistant',
			createdAt: now,
			text: 'streaming',
		};
		// The user turn (gen-2) is unanswered, but a separate generation is live.
		const turn = userTurn({ id: 'u2', generationId: 'gen-2' });
		expect(findUnansweredTurn([turn, live], now)).toBeUndefined();
	});
});
