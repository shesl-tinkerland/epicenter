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
	appendUserMessage,
	attachChatTranscript,
	type ChatDocMessage,
	chatDocToPrompt,
	findLatestUserTurn,
	findUnansweredTurn,
	readChatDocMessages,
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
		// The server generation worker writes assistant messages via the free
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

describe('the parts body', () => {
	test('a user turn is one text part; read derives its text from that part', () => {
		const doc = new Y.Doc({ guid: 'chat-user-part' });
		appendUserMessage(doc, {
			id: 'u1',
			content: 'hello',
			createdAt: 1,
			generationId: 'g1',
		});

		const message = readChatDocMessages(doc)[0];
		expect(message?.parts).toEqual([{ type: 'text', content: 'hello' }]);
		expect(message?.text).toBe('hello');
		doc.destroy();
	});

	test('streamed deltas suffix-append into one trailing text part, not one part per call', () => {
		const doc = new Y.Doc({ guid: 'chat-stream-part' });
		const writer = appendAssistantMessage(doc, { id: 'a1', createdAt: 1 });
		writer.appendText('你');
		writer.appendText('好');
		writer.finish({ kind: 'completed' }, { text: '!' });

		const message = readChatDocMessages(doc)[0];
		// One text part holds the whole stream; the body is not fragmented per delta.
		expect(message?.parts).toEqual([{ type: 'text', content: '你好!' }]);
		expect(message?.text).toBe('你好!');
		expect(message?.finish).toEqual({ kind: 'completed' });
		doc.destroy();
	});

	test('an assistant turn with no tokens is an empty body (the thinking marker)', () => {
		const doc = new Y.Doc({ guid: 'chat-empty-part' });
		appendAssistantMessage(doc, { id: 'a1', createdAt: 1 });

		const message = readChatDocMessages(doc)[0];
		expect(message?.parts).toEqual([]);
		expect(message?.text).toBe('');
		doc.destroy();
	});

	test('chatDocToPrompt walks parts and is identical to the single-content output for text', () => {
		const doc = new Y.Doc({ guid: 'chat-prompt-part' });
		appendUserMessage(doc, {
			id: 'u1',
			content: 'hi',
			createdAt: 1,
			generationId: 'a1',
		});
		const writer = appendAssistantMessage(doc, { id: 'a1', createdAt: 2 });
		writer.appendText('answer');
		writer.finish({ kind: 'completed' });
		// An interrupted assistant turn with no tokens: carries no signal, dropped.
		appendAssistantMessage(doc, { id: 'a2', createdAt: 3 });

		expect(chatDocToPrompt(readChatDocMessages(doc))).toEqual([
			{ role: 'user', content: 'hi' },
			{ role: 'assistant', content: 'answer' },
		]);
		doc.destroy();
	});

	test('observe fires when a token appends into a part Y.Text', () => {
		const doc = new Y.Doc({ guid: 'chat-observe-part' });
		const transcript = attachChatTranscript(doc);
		const writer = appendAssistantMessage(doc, { id: 'a1', createdAt: 1 });

		let fired = 0;
		const unobserve = transcript.observe(() => fired++);
		writer.appendText('token');
		expect(fired).toBeGreaterThan(0);

		unobserve();
		doc.destroy();
	});

	test('reads tool-call and tool-result parts, deriving text from text parts only', () => {
		// Phase 1 never writes tool parts, so build them raw to cover the reader's
		// durable branches: a synced Local Books answer is text + a recipe + a result.
		const doc = new Y.Doc({ guid: 'chat-tool-parts' });
		doc.transact(() => {
			const map = new Y.Map<unknown>();
			const parts = new Y.Array<Y.Map<unknown>>();

			const textPart = new Y.Map<unknown>();
			const prose = new Y.Text();
			prose.insert(0, 'Here are the rows:');
			textPart.set('type', 'text');
			textPart.set('content', prose);

			const callPart = new Y.Map<unknown>();
			const args = new Y.Text();
			args.insert(0, '{"sql":"select 1"}');
			callPart.set('type', 'tool-call');
			callPart.set('id', 'tc1');
			callPart.set('name', 'runSql');
			callPart.set('arguments', args);
			callPart.set('input', { sql: 'select 1' });
			callPart.set('state', 'input-complete');

			const resultPart = new Y.Map<unknown>();
			resultPart.set('type', 'tool-result');
			resultPart.set('toolCallId', 'tc1');
			resultPart.set('content', '1 row');
			resultPart.set('state', 'complete');

			parts.push([textPart, callPart, resultPart]);
			map.set('id', 'a1');
			map.set('role', 'assistant');
			map.set('createdAt', 1);
			map.set('parts', parts);
			doc.getArray<Y.Map<unknown>>('messages').push([map]);
		});

		const message = readChatDocMessages(doc)[0];
		expect(message?.parts).toEqual([
			{ type: 'text', content: 'Here are the rows:' },
			{
				type: 'tool-call',
				id: 'tc1',
				name: 'runSql',
				arguments: '{"sql":"select 1"}',
				input: { sql: 'select 1' },
				state: 'input-complete',
			},
			{
				type: 'tool-result',
				toolCallId: 'tc1',
				content: '1 row',
				state: 'complete',
			},
		]);
		// Derived text is the prose only; the tool parts do not leak into it.
		expect(message?.text).toBe('Here are the rows:');
		doc.destroy();
	});

	test('skips a malformed part but keeps the well-formed ones around it', () => {
		const doc = new Y.Doc({ guid: 'chat-malformed-part' });
		doc.transact(() => {
			const map = new Y.Map<unknown>();
			const parts = new Y.Array<Y.Map<unknown>>();

			const good = new Y.Map<unknown>();
			const text = new Y.Text();
			text.insert(0, 'kept');
			good.set('type', 'text');
			good.set('content', text);

			// A foreign part with an unknown type: a hole, not a crash.
			const foreign = new Y.Map<unknown>();
			foreign.set('type', 'mystery');

			parts.push([good, foreign]);
			map.set('id', 'a1');
			map.set('role', 'assistant');
			map.set('createdAt', 1);
			map.set('parts', parts);
			doc.getArray<Y.Map<unknown>>('messages').push([map]);
		});

		const message = readChatDocMessages(doc)[0];
		expect(message?.parts).toEqual([{ type: 'text', content: 'kept' }]);
		doc.destroy();
	});

	test('a pre-parts message (legacy content, no parts) is skipped: the clean break', () => {
		const doc = new Y.Doc({ guid: 'chat-legacy' });
		doc.transact(() => {
			const map = new Y.Map<unknown>();
			const content = new Y.Text();
			content.insert(0, 'old answer');
			map.set('id', 'a1');
			map.set('role', 'assistant');
			map.set('createdAt', 1);
			map.set('content', content); // old shape, no `parts` array
			doc.getArray<Y.Map<unknown>>('messages').push([map]);
		});

		// No migration reader: a message without `parts` reads as nothing.
		expect(readChatDocMessages(doc)).toEqual([]);
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
		parts: [{ type: 'text', content: 'ask' }],
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
			parts: [],
			text: '',
		};
		expect(findUnansweredTurn([userTurn(), claimed], now)).toBeUndefined();
	});

	test('returns undefined while a recent unfinished assistant turn is still live', () => {
		const live: ChatDocMessage = {
			id: 'other',
			role: 'assistant',
			createdAt: now,
			parts: [{ type: 'text', content: 'streaming' }],
			text: 'streaming',
		};
		// The user turn (gen-2) is unanswered, but a separate generation is live.
		const turn = userTurn({ id: 'u2', generationId: 'gen-2' });
		expect(findUnansweredTurn([turn, live], now)).toBeUndefined();
	});
});
