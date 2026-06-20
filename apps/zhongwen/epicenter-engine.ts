/**
 * The metered Epicenter engine: a zhongwen {@link Engine} that answers on the
 * user's Epicenter account over the `/api/ai/chat` SSE stream (the Epicenter
 * provider, ADR-0033). Both peers that can power it (an open browser tab, a
 * signed-in daemon) build it the same way, so the wire shape (the AI-chat fetch
 * wrapper, the route, the `model` + `systemPrompts` body) is single-homed here
 * instead of duplicated at each call site.
 *
 * It lives outside the dep-free contract (`zhongwen.ts`) on purpose: it pulls in
 * `@epicenter/client`, so it is its own subpath (`@epicenter/zhongwen/engine`),
 * and each peer constructs it from its own session fetch and base URL.
 */

import type { AuthFetch } from '@epicenter/auth';
import {
	createAiChatFetch,
	createEpicenterProviderChatStream,
} from '@epicenter/client';
import { API_ROUTES } from '@epicenter/constants/api-routes';
import {
	type Engine,
	ZHONGWEN_MODEL,
	ZHONGWEN_SYSTEM_PROMPT,
} from './zhongwen.js';

/**
 * Build the metered Epicenter {@link Engine} for one peer.
 *
 * @param sessionFetch the peer's authenticated fetch (the browser's `auth.fetch`,
 *   the daemon's `session.fetch`); wrapped here for the AI-chat route.
 * @param baseURL the Epicenter API origin the SSE route lives under.
 */
export function epicenterMeteredEngine(
	sessionFetch: AuthFetch,
	baseURL: string,
): Engine {
	return () =>
		createEpicenterProviderChatStream({
			fetch: createAiChatFetch(sessionFetch),
			url: API_ROUTES.ai.chat.url(baseURL),
			data: () => ({
				model: ZHONGWEN_MODEL,
				systemPrompts: [ZHONGWEN_SYSTEM_PROMPT],
			}),
		});
}
