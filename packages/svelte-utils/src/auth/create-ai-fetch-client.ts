import {
	type AiChatError,
	AiChatHttpError,
} from '@epicenter/constants/ai-chat-errors';

/**
 * Wrap an authenticated fetch client to read structured error bodies
 * before TanStack AI's adapter can throw a generic status-only error.
 *
 * When the server returns a non-2xx response, this wrapper:
 * 1. Reads the JSON body (wellcrafted's `{ data, error }` envelope)
 * 2. Extracts the structured error (`name`, `message`, variant fields)
 * 3. Throws an `AiChatHttpError` with `.status` and `.serverError`
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
 * import { createAiFetchClient } from '@epicenter/svelte-utils';
 * import { AiChatHttpError } from '@epicenter/constants/ai-chat-errors';
 *
 * // In chat-state.svelte.ts:
 * connection: fetchServerSentEvents(
 *   () => `${APP_URLS.API}/ai/chat`,
 *   async () => ({
 *     fetchClient: createAiFetchClient(auth.fetch),
 *     body: { data: { provider, model } },
 *   }),
 * ),
 *
 * // Then in error handling:
 * if (chat.error instanceof AiChatHttpError) {
 *   switch (chat.error.serverError.name) {
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

export function createAiFetchClient(authFetch: FetchFn): FetchFn {
	return async (input, init) => {
		const response = await authFetch(input, init);

		if (!response.ok) {
			let serverError: AiChatError | undefined;
			try {
				const body = await response.json();
				// wellcrafted Err envelope: { data: null, error: { name, message, ... } }
				if (
					body?.error &&
					typeof body.error === 'object' &&
					'name' in body.error
				) {
					serverError = body.error as AiChatError;
				}
			} catch {
				// Body wasn't JSON — fall through with undefined serverError
			}

			if (serverError) {
				throw new AiChatHttpError(response.status, serverError);
			}

			// Non-JSON or unrecognized error body — throw generic Error
			throw new Error(
				`HTTP error! status: ${response.status} ${response.statusText}`,
			);
		}

		return response;
	};
}
