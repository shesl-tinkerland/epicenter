/**
 * The inference backend as a single `ChatStream` (S5). With `GEMINI_API_KEY`
 * set, this is real Gemini, built exactly as `apps/vocab/mount.ts` builds it
 * (`createGeminiChat` + `chat({ adapter, messages, abortController })`). With no
 * key it falls back to a slow echo so S1-S4 run with zero setup.
 *
 * Swapping real inference in is this one function, not a rewrite: the worker's
 * append loop is identical either way (`startStream(messages, signal)`).
 */

import type { ChatStream } from '@epicenter/workspace/ai';
import { chat, EventType, type StreamChunk } from '@tanstack/ai';
import { createGeminiChat } from '@tanstack/ai-gemini';

const FIRST_TOKEN_WARN_MS = Number(process.env.FIRST_TOKEN_WARN_MS ?? 5_000);

/**
 * Echo the last user message, one character at a time, slowly enough that you
 * can type `/cancel` mid-stream (S3). Honors the abort signal exactly like a
 * real backend must, so the durable-cancel path is real, not simulated.
 */
const echoStream: ChatStream = async function* (messages, signal) {
	const last = messages[messages.length - 1];
	const said =
		typeof last?.content === 'string'
			? last.content
			: JSON.stringify(last?.content ?? '');
	const reply = `You said: "${said}". This is the demo worker streaming an echo through the synced doc, one character at a time, slowly enough that you can type /cancel mid-stream to exercise the durable, offline-survivable cancel path.`;
	for (const char of reply) {
		if (signal.aborted) return;
		yield {
			type: EventType.TEXT_MESSAGE_CONTENT,
			messageId: 'echo',
			delta: char,
		} as StreamChunk;
		await new Promise((resolve) => setTimeout(resolve, 30));
	}
};

/** Pick the backend once: real Gemini if keyed, otherwise the echo. */
export function resolveChatStream(): ChatStream {
	const apiKey = process.env.GEMINI_API_KEY;
	if (!apiKey) {
		console.log('(no GEMINI_API_KEY — using the echo stream)');
		return echoStream;
	}
	const model = (process.env.GEMINI_MODEL ?? 'gemini-3.5-flash') as Parameters<
		typeof createGeminiChat
	>[0];
	console.log(`(GEMINI_API_KEY set — real inference via ${model})`);
	const adapter = createGeminiChat(model, apiKey);
	return async function* geminiStream(messages, signal) {
		const abortController = new AbortController();
		if (signal.aborted) abortController.abort();
		else
			signal.addEventListener('abort', () => abortController.abort(), {
				once: true,
			});

		const startedAt = Date.now();
		let sawFirstChunk = false;
		const warning = setTimeout(() => {
			if (!sawFirstChunk && !signal.aborted) {
				console.warn(
					`[gemini] still waiting for first chunk after ${Date.now() - startedAt}ms`,
				);
			}
		}, FIRST_TOKEN_WARN_MS);

		console.log(
			`[gemini] request started · model=${model} · messages=${messages.length}`,
		);

		try {
			for await (const chunk of chat({
				adapter,
				messages,
				systemPrompts: ['You are a concise, friendly demo assistant.'],
				abortController,
			})) {
				if (!sawFirstChunk) {
					// Tokens are flowing: stop the slow-first-token warning. The
					// `finally` clears it on every exit; this clears it mid-stream so
					// it can't fire after the first chunk lands.
					sawFirstChunk = true;
					clearTimeout(warning);
					console.log(
						`[gemini] first chunk after ${Date.now() - startedAt}ms · type=${chunk.type}`,
					);
				}
				if (chunk.type === EventType.RUN_ERROR) {
					console.error(
						`[gemini] provider run error · code=${chunk.code ?? 'provider-error'} · ${chunk.message}`,
					);
				}
				yield chunk;
			}
			console.log(`[gemini] stream ended after ${Date.now() - startedAt}ms`);
		} catch (cause) {
			if (signal.aborted) {
				console.log(`[gemini] aborted after ${Date.now() - startedAt}ms`);
				return;
			}
			console.error(
				`[gemini] request failed after ${Date.now() - startedAt}ms · ${formatProviderError(cause)}`,
			);
			throw cause;
		} finally {
			// One cleanup site for every exit: normal end, throw, abort, and a
			// consumer that abandons this generator via `.return()` on cancel.
			clearTimeout(warning);
		}
	};
}

function formatProviderError(cause: unknown): string {
	if (!(cause instanceof Error)) return String(cause);
	const parts = [cause.name, cause.message].filter(Boolean);
	const maybeStatus =
		'status' in cause ? `status=${String(cause.status)}` : undefined;
	return [maybeStatus, ...parts].filter(Boolean).join(' · ');
}
