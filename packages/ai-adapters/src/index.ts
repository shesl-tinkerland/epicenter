import {
	type AiProvider,
	MODELS_BY_ID,
	type ServableModel,
} from '@epicenter/constants/ai-providers';
import {
	type AnyTextAdapter,
	chat,
	type ModelMessage,
	type StreamChunk,
} from '@tanstack/ai';
import { createGeminiChat } from '@tanstack/ai-gemini';
import { createOpenaiChat } from '@tanstack/ai-openai';

/**
 * Construct the TanStack text adapter for an Epicenter model id. This is the
 * executable twin of the model catalog (`MODELS_BY_ID`): the catalog owns the
 * model -> provider data, this owns turning that data into a live adapter. The
 * discriminated switch narrows `entry.id` to each SDK's model union, so the
 * construction calls are typed with no cast.
 *
 * The body is only the provider switch: no key policy, no `Result`. The caller
 * owns where the key comes from (BYOK vs house) and what an absent key means;
 * see `resolveAdapter` in `@epicenter/server` and `resolveChatStream` in the
 * vocab daemon.
 */
export function createAdapterForModel(
	model: ServableModel,
	apiKey: string,
): AnyTextAdapter {
	const entry = MODELS_BY_ID[model];
	switch (entry.provider) {
		case 'openai':
			return createOpenaiChat(entry.id, apiKey);
		case 'gemini':
			return createGeminiChat(entry.id, apiKey);
		default:
			return entry satisfies never;
	}
}

/**
 * Structurally `@epicenter/workspace/ai`'s `ChatStream`, the one contract every
 * inference backend speaks. Inlined so this leaf does not depend on the
 * workspace core for a function signature, the same decoupling
 * `@epicenter/client`'s `createEpicenterProviderChatStream` makes.
 */
type ChatStream = (
	messages: ModelMessage[],
	signal: AbortSignal,
) => AsyncIterable<StreamChunk>;

/**
 * Drive a constructed text adapter as a {@link ChatStream}: the BYOK inference
 * backend (ADR-0038's `byok` arm). Pair it with {@link createAdapterForModel}:
 * the catalog gives the provider, that builds the adapter from a key, and this
 * turns the adapter into the stream the answer loop consumes.
 *
 * The answer loop hands an `AbortSignal`; `chat()` cancels on an
 * `AbortController`, so the signal is bridged onto one (forwarded if already
 * aborted, else once on the first abort). The metered backend
 * (`createEpicenterProviderChatStream`) and the daemon's placeholder are its
 * siblings; this is the adapter arm, named once so every SDK-driven host (the
 * vocab daemon today) shares one builder instead of re-bridging the signal.
 */
export function chatStreamFromAdapter(
	adapter: AnyTextAdapter,
	systemPrompts: string[],
): ChatStream {
	return (messages, signal) => {
		const abortController = new AbortController();
		if (signal.aborted) abortController.abort();
		else
			signal.addEventListener('abort', () => abortController.abort(), {
				once: true,
			});
		return chat({ adapter, messages, systemPrompts, abortController });
	};
}

/**
 * The deployment env var that holds each provider's house key, in one place.
 * Both house-key consumers (`resolveAdapter` in `@epicenter/server` and the
 * vocab daemon's `resolveChatStream`) read this rather than re-deriving the
 * name, so the provider -> env-var fact is single-homed. `satisfies Record<…>`
 * keeps it exhaustive: a new provider that lacks an entry is a compile error.
 *
 * It lives in this server/daemon-only leaf, not the browser-facing catalog, so
 * the secret-naming never reaches a browser bundle.
 */
export const HOUSE_KEY_ENV_VAR = {
	openai: 'OPENAI_API_KEY',
	gemini: 'GEMINI_API_KEY',
} as const satisfies Record<AiProvider, string>;
