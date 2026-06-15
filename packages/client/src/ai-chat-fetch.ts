import {
	type AiChatError,
	AiChatHttpError,
} from '@epicenter/constants/ai-chat-errors';
import { Ok, tryAsync } from 'wellcrafted/result';

/**
 * Wrap an authenticated fetch client to read structured error bodies
 * before TanStack AI's adapter can throw a generic status-only error.
 *
 * When the server returns a non-2xx response, this wrapper:
 * 1. Reads the JSON body (wellcrafted's `{ data, error }` envelope)
 * 2. Extracts the structured error (`name`, `message`, variant fields)
 * 3. Throws an `AiChatHttpError` carrying that detail
 *
 * The HTTP status is not serialized into the error body; the server holds
 * it in a sibling `AiChatErrorStatus` map keyed by variant name. Client
 * code that needs the status should read it from `response.status`, or
 * import `AiChatErrorStatus` and look it up by `err.detail.name`.
 *
 * The thrown error propagates unchanged through TanStack AI's
 * `ChatClient` pipeline to `onError` / `chat.error`. Use
 * `instanceof AiChatHttpError` on the client side to narrow it.
 *
 * @param authFetch - An authenticated fetch function (e.g. `auth.fetch`)
 * @returns A fetch-compatible function that enriches errors with server data
 *
 * @example
 * ```ts
 * import { createAiChatFetch } from '@epicenter/client';
 * import { AiChatHttpError } from '@epicenter/constants/ai-chat-errors';
 *
 * // In chat-state.svelte.ts:
 * connection: fetchServerSentEvents(
 *   () => `${APP_URLS.API}/ai/chat`,
 *   async () => ({
 *     fetchClient: createAiChatFetch(auth.fetch),
 *     body: { data: { provider, model } },
 *   }),
 * ),
 *
 * // Then in error handling:
 * if (chat.error instanceof AiChatHttpError) {
 *   switch (chat.error.detail.name) {
 *     case 'Unauthorized': // show sign-in
 *     case 'InsufficientCredits': // show upgrade
 *   }
 * }
 * ```
 */
type FetchFn = (
	input: RequestInfo | URL,
	init?: RequestInit,
) => Promise<Response>;

export function createAiChatFetch(authFetch: FetchFn): typeof fetch {
	const fetchClient = async (input: RequestInfo | URL, init?: RequestInit) => {
		const response = await authFetch(input, init);
		if (response.ok) return response;

		// Read the body before TanStack AI's adapter can throw its generic
		// "HTTP error! status: 401" without reading it.
		const { data: detail } = await tryAsync({
			try: async () => {
				const body = await response.json();
				if (
					body?.error &&
					typeof body.error === 'object' &&
					'name' in body.error
				) {
					return body.error as AiChatError;
				}
			},
			catch: () => Ok(undefined),
		});

		if (detail) {
			throw new AiChatHttpError(detail);
		}

		throw new Error(
			`HTTP error! status: ${response.status} ${response.statusText}`,
		);
	};

	// `fetchClient` must stay assignable to TanStack AI's `typeof fetch`
	// option, whose type carries a `preconnect` member under Node libs.
	// Reading the global `fetch.preconnect` fails to type-check under the
	// DOM lib that the browser-app consumers recompile this source with,
	// and SSE only ever invokes `fetchClient` as a function: a no-op
	// satisfies the structural contract.
	return Object.assign(fetchClient, { preconnect: () => {} });
}
