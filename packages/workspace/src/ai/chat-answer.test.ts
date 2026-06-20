/**
 * Tests for `streamAnswer`: the shared answer core.
 *
 * The core is driven with a fake `ChatStream` and a fake writer that records its
 * `appendText` calls, so each test asserts the buffer/flush behavior and the
 * outcome directly, with no Y.Doc. The terminal `finish` is the wrapper's job
 * (the core never writes it), so these tests prove the seam: the core hands back
 * `{ aborted, runError?, tail }` and writes nothing terminal.
 */

import { describe, expect, test } from 'bun:test';
import { EventType, type StreamChunk } from '@tanstack/ai';
import { type ChatStream, streamAnswer } from './chat-answer.js';

function textChunk(delta: string): StreamChunk {
	return {
		type: EventType.TEXT_MESSAGE_CONTENT,
		messageId: 'message-1',
		delta,
	} as StreamChunk;
}

/** A writer that records `appendText` calls; the core never calls `finish`. */
function fakeWriter() {
	const appended: string[] = [];
	return {
		appended,
		appendText(text: string) {
			appended.push(text);
		},
	};
}

/** A `ChatStream` that yields the given deltas back to back, then ends. */
function streamOf(...deltas: string[]): ChatStream {
	return async function* () {
		for (const delta of deltas) yield textChunk(delta);
	};
}

describe('streamAnswer', () => {
	test('batches rapid deltas: the first flushes, the rest ride the tail', async () => {
		// Eight deltas arriving faster than FLUSH_INTERVAL_MS (75ms): lastFlushAt
		// starts at 0 so the first flushes at once; the rest buffer into the tail.
		const deltas = Array.from({ length: 8 }, (_, index) => `d${index}`);
		const writer = fakeWriter();

		const outcome = await streamAnswer({
			writer,
			startStream: streamOf(...deltas),
			prompt: [],
			signal: new AbortController().signal,
		});

		expect(writer.appended).toEqual(['d0']);
		expect(outcome.tail).toBe(deltas.slice(1).join(''));
		expect(outcome.aborted).toBe(false);
		expect(outcome.runError).toBeUndefined();
	});

	test('flushes when the buffer passes FLUSH_MAX_CHARS', async () => {
		// 'a' flushes immediately (the interval); a 600-char delta in the same tick
		// passes the 512 cap and flushes too, leaving an empty tail.
		const big = 'x'.repeat(600);
		const writer = fakeWriter();

		const outcome = await streamAnswer({
			writer,
			startStream: streamOf('a', big),
			prompt: [],
			signal: new AbortController().signal,
		});

		expect(writer.appended).toEqual(['a', big]);
		expect(outcome.tail).toBe('');
	});

	test('captures a provider RUN_ERROR and keeps the streamed text', async () => {
		const startStream: ChatStream = async function* () {
			yield textChunk('partial');
			yield {
				type: EventType.RUN_ERROR,
				message: 'model exploded',
				code: 'provider-overloaded',
			} as StreamChunk;
		};
		const writer = fakeWriter();

		const outcome = await streamAnswer({
			writer,
			startStream,
			prompt: [],
			signal: new AbortController().signal,
		});

		expect(outcome.runError).toEqual({
			code: 'provider-overloaded',
			message: 'model exploded',
		});
		// A RUN_ERROR event is not a throw, so it carries no `cause`.
		expect(outcome.runError?.cause).toBeUndefined();
		expect(outcome.aborted).toBe(false);
		// 'partial' is the first delta, so it flushed on the interval; nothing is
		// left buffered.
		expect(writer.appended).toEqual(['partial']);
		expect(outcome.tail).toBe('');
	});

	test('captures a thrown stream error with its cause', async () => {
		const boom = new Error('socket reset');
		const startStream: ChatStream = async function* () {
			yield textChunk('partial');
			throw boom;
		};
		const writer = fakeWriter();

		const outcome = await streamAnswer({
			writer,
			startStream,
			prompt: [],
			signal: new AbortController().signal,
		});

		expect(outcome.aborted).toBe(false);
		expect(outcome.runError).toMatchObject({
			code: 'stream-error',
			message: 'socket reset',
			cause: boom,
		});
		expect(writer.appended).toEqual(['partial']);
		expect(outcome.tail).toBe('');
	});

	test('abort stops the loop and returns without finishing', async () => {
		// Aborting between yields: the post-abort chunk is received but the
		// signal-check at the loop top drops it before it is appended.
		const controller = new AbortController();
		const startStream: ChatStream = async function* () {
			yield textChunk('first ');
			controller.abort();
			yield textChunk('second');
		};
		const writer = fakeWriter();

		const outcome = await streamAnswer({
			writer,
			startStream,
			prompt: [],
			signal: controller.signal,
		});

		expect(outcome.aborted).toBe(true);
		expect(outcome.runError).toBeUndefined();
		// 'first ' flushed on the interval; 'second' never lands.
		expect(writer.appended).toEqual(['first ']);
		expect(outcome.tail).toBe('');
	});

	test('a stream that throws after abort is a cancellation, not a failure', async () => {
		// A provider that throws on abort (the common case) must not surface as a
		// runError: the signal already aborted, so the outcome is a clean abort.
		const controller = new AbortController();
		const startStream: ChatStream = async function* () {
			yield textChunk('first ');
			controller.abort();
			throw new Error('aborted by provider');
		};
		const writer = fakeWriter();

		const outcome = await streamAnswer({
			writer,
			startStream,
			prompt: [],
			signal: controller.signal,
		});

		expect(outcome.aborted).toBe(true);
		expect(outcome.runError).toBeUndefined();
	});
});
