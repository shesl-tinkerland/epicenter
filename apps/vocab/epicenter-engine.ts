/**
 * The metered Epicenter backend: an {@link AgentEngine} the client agent loop
 * (ADR-0047) drives over the OpenAI-compatible gateway (`/v1/chat/completions`)
 * on the user's Epicenter account (ADR-0049/0050). The base URL is the swap
 * point: it defaults to the Epicenter gateway here, the only thing a self-hosted
 * or local backend would change. The wire shape (the authed fetch, the base URL,
 * the `model` + `systemPrompts` body) is single-homed here instead of inlined at
 * the call site.
 *
 * Vocab is capability-free, so each step sends an empty tool catalog and the loop
 * runs a single text step per turn; the same engine a tool agent uses, with no
 * tools.
 *
 * It lives outside the dep-free contract (`vocab.ts`) on purpose: it pulls in
 * `@epicenter/client`, so it is its own subpath (`@epicenter/vocab/engine`),
 * built from the browser's session fetch and base URL.
 */

import type { AuthFetch } from '@epicenter/auth';
import { type AgentEngine, createOpenAiAgentEngine } from '@epicenter/client';
import { API_ROUTES } from '@epicenter/constants/api-routes';
import { VOCAB_MODEL, VOCAB_SYSTEM_PROMPT } from './vocab.js';

/**
 * Build the metered Epicenter {@link AgentEngine} the browser answers with.
 *
 * @param sessionFetch the browser's authenticated fetch (`auth.fetch`), wrapped
 *   here for the AI-chat route.
 * @param baseURL the Epicenter API origin the SSE route lives under.
 */
export function epicenterMeteredEngine(
	sessionFetch: AuthFetch,
	baseURL: string,
): AgentEngine {
	return createOpenAiAgentEngine({
		fetch: sessionFetch,
		baseURL: API_ROUTES.ai.completions.baseUrl(baseURL),
		data: () => ({
			model: VOCAB_MODEL,
			systemPrompts: [VOCAB_SYSTEM_PROMPT],
		}),
	});
}
