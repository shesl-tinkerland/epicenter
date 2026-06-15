import { API_ROUTES } from '@epicenter/constants/api-routes';
import { APP_URLS } from '@epicenter/constants/vite';

const GLOSS_SYSTEM_PROMPT =
	'You are a Chinese vocabulary tutor. Give a concise English meaning of the ' +
	'given word as it is used in the sentence. Reply with the meaning only: one ' +
	'short line, no pinyin, no preamble, no quotes.';

// A word's meaning is contextual, so the cache keys on the sentence too: the same
// word in a different line earns its own gloss. Session-lived and unbounded by
// design (a personal chat taps few enough words for this to never matter).
const glossCache = new Map<string, string>();
const cacheKey = (word: string, context: string) => `${word}\n${context}`;

/** A previously streamed gloss for this word-in-context, if one has landed. */
export function cachedGloss(word: string, context: string): string | undefined {
	return glossCache.get(cacheKey(word, context));
}

/**
 * Stream a one-shot contextual gloss from `/api/ai/chat`, invoking `onText` with
 * the text accumulated so far as deltas arrive.
 *
 * Out-of-band by design: this hits the plain chat route, never `chatDoc`, so a
 * gloss never writes to a conversation doc and so never pollutes the transcript
 * or the reflection roster. That separation is why the gloss is a model call and
 * not a turn in the chat.
 *
 * The wire format is TanStack AI's SSE: `data: <StreamChunk JSON>\n\n` frames,
 * where `TEXT_MESSAGE_CONTENT` chunks carry a `delta` string. Other chunk types
 * (run lifecycle, thinking) are ignored; the stream ends when the body closes.
 */
export async function streamGloss({
	fetchFn,
	word,
	context,
	provider,
	model,
	signal,
	onText,
}: {
	fetchFn: typeof fetch;
	word: string;
	context: string;
	provider: string;
	model: string;
	signal: AbortSignal;
	onText: (text: string) => void;
}): Promise<void> {
	const userContent = context
		? `Word: ${word}\nSentence: ${context}`
		: `Word: ${word}`;
	const response = await fetchFn(API_ROUTES.ai.chat.url(APP_URLS.API), {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			messages: [{ role: 'user', content: userContent }],
			data: { provider, model, systemPrompts: [GLOSS_SYSTEM_PROMPT] },
		}),
		signal,
	});
	if (!response.ok || !response.body) {
		throw new Error(`Gloss request failed (${response.status})`);
	}

	const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
	let buffer = '';
	let text = '';
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		buffer += value;
		// SSE frames are separated by a blank line; hold the trailing partial.
		const frames = buffer.split('\n\n');
		buffer = frames.pop() ?? '';
		for (const frame of frames) {
			const line = frame.trim();
			if (!line.startsWith('data:')) continue;
			const payload = line.slice(5).trim();
			if (!payload) continue;
			const chunk = JSON.parse(payload) as { type?: string; delta?: string };
			if (chunk.type === 'TEXT_MESSAGE_CONTENT' && chunk.delta) {
				text += chunk.delta;
				onText(text);
			}
		}
	}

	// The stream closed cleanly (an abort would have thrown before here), so the
	// gloss is complete and worth caching. Skip empties so a dropped stream is
	// retried rather than memoized as blank.
	if (text) glossCache.set(cacheKey(word, context), text);
}
