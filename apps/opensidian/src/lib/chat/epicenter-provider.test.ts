/**
 * End-to-end test of opensidian's render-from-doc inference path: the Epicenter
 * provider parses the `/api/ai/chat` SSE stream into chunks, the browser answerer
 * sinks them into the transcript doc, and the doc carries the streamed reply and
 * a terminal finish. A fake `fetch` stands in for the route, so this exercises
 * the real SSE parser, the real answerer, and the real doc layout without a
 * network or a browser.
 */

import { describe, expect, test } from 'bun:test';
import { createEpicenterProviderChatStream } from '@epicenter/client';
import {
	AiChatError,
	AiChatHttpError,
} from '@epicenter/constants/ai-chat-errors';
import {
	attachChatBrowserAnswerer,
	attachChatTranscript,
} from '@epicenter/workspace/ai';
import { EventType, type StreamChunk } from '@tanstack/ai';
import * as Y from 'yjs';

/** Encode chunks as the `data: <json>\n\n` frames `toServerSentEventsResponse` emits. */
function sseResponse(
	chunks: StreamChunk[],
	{ split = false }: { split?: boolean } = {},
): Response {
	const encoder = new TextEncoder();
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const chunk of chunks) {
				const frame = `data: ${JSON.stringify(chunk)}\n\n`;
				if (split) {
					// Cut the frame mid-way to prove the parser buffers partial frames.
					const at = Math.floor(frame.length / 2);
					controller.enqueue(encoder.encode(frame.slice(0, at)));
					controller.enqueue(encoder.encode(frame.slice(at)));
				} else {
					controller.enqueue(encoder.encode(frame));
				}
			}
			controller.close();
		},
	});
	return new Response(body, {
		status: 200,
		headers: { 'content-type': 'text/event-stream' },
	});
}

function textChunk(delta: string): StreamChunk {
	return {
		type: EventType.TEXT_MESSAGE_CONTENT,
		messageId: 'm1',
		delta,
	} as StreamChunk;
}

/** A `fetch` that returns a fixed Response, ignoring its input. */
function fetchReturning(response: Response | (() => never)) {
	return (async () => {
		if (typeof response === 'function') return response();
		return response;
	}) as unknown as typeof globalThis.fetch;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('Epicenter provider over the browser answerer', () => {
	test('streams the SSE reply into the transcript doc and finishes completed', async () => {
		const doc = new Y.Doc({ guid: 'opensidian-provider-test' });
		const transcript = attachChatTranscript(doc);
		const stop = attachChatBrowserAnswerer({
			doc,
			startStream: createEpicenterProviderChatStream({
				fetch: fetchReturning(
					sseResponse([textChunk('Hello'), textChunk(', world')], {
						split: true,
					}),
				),
				url: 'https://example.test/api/ai/chat',
				data: () => ({ model: 'gpt-5.5', systemPrompts: ['sys'] }),
			}),
		});

		transcript.appendUser({
			id: 'u1',
			content: 'hi',
			createdAt: 1,
			generationId: 'gen-1',
		});
		await tick();

		expect(transcript.read().at(-1)).toMatchObject({
			id: 'gen-1',
			role: 'assistant',
			text: 'Hello, world',
			finish: { kind: 'completed' },
		});
		stop();
		doc.destroy();
	});

	test('a non-2xx (InsufficientCredits) becomes a failed finish carrying the code', async () => {
		const doc = new Y.Doc({ guid: 'opensidian-provider-error' });
		const transcript = attachChatTranscript(doc);
		const stop = attachChatBrowserAnswerer({
			doc,
			startStream: createEpicenterProviderChatStream({
				// createAiChatFetch throws AiChatHttpError on a non-2xx response.
				fetch: fetchReturning(() => {
					throw new AiChatHttpError(
						AiChatError.InsufficientCredits({ balance: 0 }).error,
					);
				}),
				url: 'https://example.test/api/ai/chat',
				data: () => ({ model: 'gpt-5.5', systemPrompts: ['sys'] }),
			}),
		});

		transcript.appendUser({
			id: 'u1',
			content: 'hi',
			createdAt: 1,
			generationId: 'gen-1',
		});
		await tick();

		expect(transcript.read().at(-1)?.finish).toEqual({
			kind: 'failed',
			code: 'InsufficientCredits',
			message: 'Insufficient credits',
		});
		stop();
		doc.destroy();
	});
});
