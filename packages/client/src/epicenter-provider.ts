/**
 * The Epicenter provider: a browser `ChatStream` that runs inference through the
 * metered `/api/ai/chat` endpoint on the user's account (the house key), so an
 * in-process answerer (`attachChatBrowserAnswerer` / `attachChatWorker` from
 * `@epicenter/workspace/ai`) gets credits without a raw provider key (ADR-0033's
 * Epicenter-provider backend).
 *
 * The endpoint streams the answer back as Server-Sent Events
 * (`toServerSentEventsResponse`), the way a provider streams; this adapter turns
 * that wire format back into the raw AG-UI `StreamChunk` iterable the answer core
 * (`streamAnswer`) consumes. TanStack ai-client (0.16.3) exposes no standalone SSE
 * parser, only `fetchServerSentEvents`, a full connection adapter that would POST
 * an AG-UI `RunAgentInput` envelope this custom `/api/ai/chat` contract does not
 * speak, so the `data:` frames are parsed here (verified; see ADR-0037).
 *
 * This lives in `@epicenter/client` (beside `createAiChatFetch`, the authed fetch
 * it expects) so every app that answers a cloud conversation in-process shares one
 * implementation. The return value is structurally a `@epicenter/workspace/ai`
 * `ChatStream`; the type is inlined here to keep the client decoupled from the
 * workspace core.
 */

import { AiChatHttpError } from '@epicenter/constants/ai-chat-errors';
import { EventType, type ModelMessage, type StreamChunk } from '@tanstack/ai';
import { extractErrorMessage } from 'wellcrafted/error';

/**
 * Structurally `@epicenter/workspace/ai`'s `ChatStream`. Inlined so the client
 * does not depend on the workspace core for a function signature.
 */
type ChatStream = (
	messages: ModelMessage[],
	signal: AbortSignal,
) => AsyncIterable<StreamChunk>;

/** The body options the `/api/ai/chat` route reads (model + system prompts). */
export type EpicenterProviderData = {
	model: string;
	systemPrompts: string[];
};

/**
 * A `RUN_ERROR` chunk the answer core turns into a `failed` finish. Carrying the
 * structured error `name` as the chunk `code` lets the failed finish keep
 * `InsufficientCredits` / `Unauthorized`, so the UI can branch on the durable
 * doc state instead of a live in-memory error.
 */
function runErrorChunk(code: string, message: string): StreamChunk {
	return { type: EventType.RUN_ERROR, code, message } as StreamChunk;
}

/**
 * Parse an SSE chat response into the raw `StreamChunk` stream. Frames are
 * double-newline separated; each carries one JSON chunk on a `data:` line, and a
 * `[DONE]` sentinel ends the run. A malformed frame is skipped (a hole, not a
 * crash), matching the answer core's tolerance for untrusted input.
 */
async function* parseServerSentEvents(
	response: Response,
	signal: AbortSignal,
): AsyncIterable<StreamChunk> {
	if (!response.body) return;
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = '';
	try {
		while (!signal.aborted) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			const frames = buffer.split('\n\n');
			// The last element is an incomplete frame; keep it for the next read.
			buffer = frames.pop() ?? '';
			for (const frame of frames) {
				const dataLine = frame
					.split('\n')
					.find((line) => line.startsWith('data:'));
				if (!dataLine) continue;
				const data = dataLine.slice('data:'.length).trimStart();
				if (data === '' || data === '[DONE]') continue;
				try {
					yield JSON.parse(data) as StreamChunk;
				} catch {
					// Skip a frame that is not valid JSON.
				}
			}
		}
	} finally {
		reader.releaseLock();
	}
}

/**
 * Build the Epicenter-provider {@link ChatStream}. `fetch` is an authenticated
 * fetch that reads the structured error body (`createAiChatFetch`), `url` is the
 * `/api/ai/chat` endpoint, and `data()` is read per turn so a mid-conversation
 * model switch takes effect on the next answer.
 */
export function createEpicenterProviderChatStream({
	fetch,
	url,
	data,
}: {
	fetch: typeof globalThis.fetch;
	url: string;
	data: () => EpicenterProviderData;
}): ChatStream {
	return async function* (
		messages: ModelMessage[],
		signal: AbortSignal,
	): AsyncIterable<StreamChunk> {
		let response: Response;
		try {
			response = await fetch(url, {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					accept: 'text/event-stream',
				},
				body: JSON.stringify({ messages, data: data() }),
				signal,
			});
		} catch (error) {
			if (signal.aborted) return;
			// `createAiChatFetch` throws `AiChatHttpError` on a non-2xx response,
			// carrying the server's structured error; surface its name as the
			// RUN_ERROR code so the failed finish stays branchable.
			if (error instanceof AiChatHttpError) {
				yield runErrorChunk(error.detail.name, error.detail.message);
				return;
			}
			yield runErrorChunk('stream-error', extractErrorMessage(error));
			return;
		}
		yield* parseServerSentEvents(response, signal);
	};
}
