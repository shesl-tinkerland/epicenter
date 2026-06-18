/**
 * Tests for `attachChatActor`: the backend-agnostic chat append loop.
 *
 * The actor is driven directly (the mount wires `observe -> onChange`; here the
 * test calls `onChange` after each write) over a real transcript doc, with the
 * inference backend injected as a fake `ChatStream`. This is the claim -> stream
 * -> finish path V0.3 shipped un-injectable and untested; with `startStream`
 * parameterized it is a fixture, so this suite also covers the V0.4 durable
 * cancel.
 */

import { describe, expect, test } from 'bun:test';
import { EventType, type ModelMessage, type StreamChunk } from '@tanstack/ai';
import * as Y from 'yjs';
import { attachChatActor, type ChatStream } from './chat-actor.js';
import { attachChatTranscript } from './chat-doc.js';

// ────────────────────────────────────────────────────────────────────────────
// Harness
// ────────────────────────────────────────────────────────────────────────────

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

/**
 * A `ChatStream` that yields `first `, then parks until `release()` before
 * yielding `second`. Lets a test interleave a cancel or teardown mid-stream.
 */
function gatedStream(): { startStream: ChatStream; release: () => void } {
	const gate = Promise.withResolvers<void>();
	return {
		startStream: async function* () {
			yield textChunk('first ');
			await gate.promise;
			yield textChunk('second');
		},
		release: gate.resolve,
	};
}

/** Drain pending microtasks so an in-flight async stream settles. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup(startStream: ChatStream) {
	const doc = new Y.Doc({ guid: 'chat-actor-test' });
	const transcript = attachChatTranscript(doc);
	const actor = attachChatActor({ ydoc: doc, startStream });
	return { doc, transcript, actor };
}

// ────────────────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────────────────

describe('attachChatActor', () => {
	test('claims the unanswered turn, streams the reply, writes finish completed', async () => {
		let prompt: ModelMessage[] | undefined;
		const startStream: ChatStream = (messages, signal) => {
			prompt = messages;
			return streamOf('你', '好', '!')(messages, signal);
		};
		const { doc, transcript, actor } = setup(startStream);

		transcript.appendUser({
			id: 'u1',
			content: 'hi',
			createdAt: 1,
			generationId: 'gen-1',
		});
		actor.onChange?.();
		await tick();

		expect(prompt).toEqual([{ role: 'user', content: 'hi' }]);
		const messages = transcript.read();
		expect(messages).toHaveLength(2);
		expect(messages[0]).toMatchObject({ id: 'u1', role: 'user', text: 'hi' });
		expect(messages[1]).toMatchObject({
			id: 'gen-1',
			role: 'assistant',
			text: '你好!',
			finish: { kind: 'completed' },
		});
		doc.destroy();
	});

	test('batches rapid deltas into a few transactions, not one per token', async () => {
		// Eight deltas that arrive faster than FLUSH_INTERVAL_MS (75ms): the first
		// flushes at once, the rest buffer and ride the finish transaction.
		const deltas = Array.from({ length: 8 }, (_, index) => `d${index}`);
		const { doc, transcript, actor } = setup(streamOf(...deltas));

		let updates = 0;
		doc.on('updateV2', () => updates++);

		transcript.appendUser({
			id: 'u1',
			content: 'hi',
			createdAt: 1,
			generationId: 'gen-1',
		});
		const baseline = updates; // the user-append transaction
		actor.onChange?.();
		await tick();

		// claim + first flush + finish-with-tail; far fewer than one per delta.
		expect(updates - baseline).toBeLessThan(deltas.length);
		expect(transcript.read().at(-1)).toMatchObject({
			text: deltas.join(''),
			finish: { kind: 'completed' },
		});
		doc.destroy();
	});

	test('a re-fire after completion is a no-op (the answer already exists)', async () => {
		const { doc, transcript, actor } = setup(streamOf('done'));

		transcript.appendUser({
			id: 'u1',
			content: 'hi',
			createdAt: 1,
			generationId: 'gen-1',
		});
		actor.onChange?.();
		await tick();
		const after = transcript.read();

		// A re-fire (e.g. our own finish write waking onChange) must not claim again.
		actor.onChange?.();
		await tick();
		expect(transcript.read()).toEqual(after);
		expect(transcript.read()).toHaveLength(2);
		doc.destroy();
	});

	test('a provider RUN_ERROR writes finish failed and keeps the streamed text', async () => {
		const startStream: ChatStream = async function* () {
			yield textChunk('partial');
			yield {
				type: EventType.RUN_ERROR,
				message: 'model exploded',
				code: 'provider-overloaded',
			} as StreamChunk;
		};
		const { doc, transcript, actor } = setup(startStream);

		transcript.appendUser({
			id: 'u1',
			content: 'hi',
			createdAt: 1,
			generationId: 'gen-1',
		});
		actor.onChange?.();
		await tick();

		expect(transcript.read().at(-1)).toMatchObject({
			text: 'partial',
			finish: {
				kind: 'failed',
				code: 'provider-overloaded',
				message: 'model exploded',
			},
		});
		doc.destroy();
	});

	test('a durable cancel mid-stream aborts and writes finish cancelled', async () => {
		const { startStream, release } = gatedStream();
		const { doc, transcript, actor } = setup(startStream);

		transcript.appendUser({
			id: 'u1',
			content: 'hi',
			createdAt: 1,
			generationId: 'gen-1',
		});
		actor.onChange?.();
		await tick(); // 'first ' appended; the stream is parked at the gate

		// The client stamps the cancel on its own turn; the next observe honors it.
		transcript.requestCancel(2);
		actor.onChange?.();

		release(); // unpark the stream; the aborted loop must not append 'second'
		await tick();

		const trailing = transcript.read().at(-1);
		expect(trailing?.text).toBe('first ');
		expect(trailing?.finish).toEqual({ kind: 'cancelled' });
		doc.destroy();
	});

	test('a turn cancelled before it could start is claimed and finished cancelled without streaming', async () => {
		let started = false;
		const startStream: ChatStream = (messages, signal) => {
			started = true;
			return streamOf('should never run')(messages, signal);
		};
		const { doc, transcript, actor } = setup(startStream);

		transcript.appendUser({
			id: 'u1',
			content: 'hi',
			createdAt: 1,
			generationId: 'gen-1',
		});
		// Cancel arrives before the actor observes the turn at all.
		transcript.requestCancel(2);
		actor.onChange?.();
		await tick();

		expect(started).toBe(false);
		const trailing = transcript.read().at(-1);
		expect(trailing).toMatchObject({
			id: 'gen-1',
			role: 'assistant',
			finish: { kind: 'cancelled' },
		});
		doc.destroy();
	});

	test('teardown stops the stream and leaves an interrupted artifact (no finish)', async () => {
		const { startStream, release } = gatedStream();
		const { doc, transcript, actor } = setup(startStream);

		transcript.appendUser({
			id: 'u1',
			content: 'hi',
			createdAt: 1,
			generationId: 'gen-1',
		});
		actor.onChange?.();
		await tick(); // 'first ' appended; the stream is parked

		// A teardown (row removed or daemon shutdown) aborts without finishing.
		actor[Symbol.dispose]?.();
		release();
		await tick();

		const trailing = transcript.read().at(-1);
		expect(trailing?.text).toBe('first ');
		expect(trailing?.finish).toBeUndefined();
		doc.destroy();
	});

	const assistantCount = (transcript: { read(): { role: string }[] }) =>
		transcript.read().filter((m) => m.role === 'assistant').length;

	test('does not start a second stream while one is in flight (no duplicate answer)', async () => {
		const { startStream, release } = gatedStream();
		const { doc, transcript, actor } = setup(startStream);

		transcript.appendUser({
			id: 'u1',
			content: 'first?',
			createdAt: 1,
			generationId: 'gen-1',
		});
		actor.onChange?.();
		await tick(); // gen-1 claimed and streaming, parked at the gate

		// A second turn arrives (e.g. another device) while gen-1 is still live.
		transcript.appendUser({
			id: 'u2',
			content: 'second?',
			createdAt: 2,
			generationId: 'gen-2',
		});
		actor.onChange?.();
		await tick();

		// The actor must NOT claim gen-2 concurrently: exactly one assistant stream.
		expect(assistantCount(transcript)).toBe(1);

		// gen-1 finishes, then the actor claims the queued gen-2.
		release();
		await tick();
		actor.onChange?.();
		await tick();

		expect(assistantCount(transcript)).toBe(2);
		expect(transcript.read().at(-1)).toMatchObject({
			id: 'gen-2',
			finish: { kind: 'completed' },
		});
		doc.destroy();
	});

	test('a retry that re-mints the turn supersedes the in-flight stream (orphan finished cancelled)', async () => {
		const { startStream, release } = gatedStream();
		const { doc, transcript, actor } = setup(startStream);

		transcript.appendUser({
			id: 'u1',
			content: 'hi',
			createdAt: 1,
			generationId: 'gen-1',
		});
		actor.onChange?.();
		await tick(); // gen-1 streaming, parked

		// The client retries: re-point the turn to a fresh id (clears the old one).
		transcript.remintGeneration('gen-2');
		actor.onChange?.();

		// The orphaned gen-1 stream is finished cancelled, not left blocking.
		expect(transcript.read().find((m) => m.id === 'gen-1')?.finish).toEqual({
			kind: 'cancelled',
		});

		// The re-pointed turn is then claimed and answered.
		release();
		await tick();
		actor.onChange?.();
		await tick();
		expect(transcript.read().at(-1)).toMatchObject({
			id: 'gen-2',
			finish: { kind: 'completed' },
		});
		doc.destroy();
	});

	test('passes an abort signal to the provider and aborts it on cancel', async () => {
		let captured: AbortSignal | undefined;
		const gate = Promise.withResolvers<void>();
		const startStream: ChatStream = (_messages, signal) => {
			captured = signal;
			return (async function* () {
				yield textChunk('first ');
				await gate.promise; // park; a real provider would abort on the signal
			})();
		};
		const { doc, transcript, actor } = setup(startStream);

		transcript.appendUser({
			id: 'u1',
			content: 'hi',
			createdAt: 1,
			generationId: 'gen-1',
		});
		actor.onChange?.();
		await tick();

		expect(captured?.aborted).toBe(false);
		transcript.requestCancel(2);
		actor.onChange?.();

		// The provider's signal is aborted, so a real backend would stop generating.
		expect(captured?.aborted).toBe(true);
		expect(transcript.read().at(-1)?.finish).toEqual({ kind: 'cancelled' });
		gate.resolve(); // unpark the abandoned generator
		doc.destroy();
	});

	test('a cancel stamped after a terminal finish is an inert no-op', async () => {
		const { doc, transcript, actor } = setup(streamOf('done'));

		transcript.appendUser({
			id: 'u1',
			content: 'hi',
			createdAt: 1,
			generationId: 'gen-1',
		});
		actor.onChange?.();
		await tick(); // completed

		// A late cancel must not write a second finish or start a new stream.
		transcript.requestCancel(99);
		actor.onChange?.();
		await tick();

		const messages = transcript.read();
		expect(messages).toHaveLength(2);
		expect(messages[1]?.finish).toEqual({ kind: 'completed' });
		doc.destroy();
	});
});
