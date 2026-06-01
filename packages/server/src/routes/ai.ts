/**
 * `/api/ai` sub-app: SSE streaming chat across OpenAI and Gemini.
 *
 * Library-side, billing-free. The deployment composes any plan or credit
 * gating in front of this app via `mountAiApp`'s `policies`. apps/api
 * passes `chargeAiCreditsWithAutumn`; a self-hosted team deployment
 * passes no policies.
 *
 * BYOK: callers may pass `apiKey` in the request body, in which case the
 * deployment's provider key is ignored. No billing implications; the
 * library treats BYOK and house-key the same.
 */

import {
	AiChatError,
	AiChatErrorStatus,
} from '@epicenter/constants/ai-chat-errors';
import { API_ROUTES } from '@epicenter/constants/api-routes';
import { sValidator } from '@hono/standard-validator';
import {
	type AnyTextAdapter,
	chat,
	type ModelMessage,
	type Tool,
	toServerSentEventsResponse,
} from '@tanstack/ai';
import { createGeminiChat, GeminiTextModels } from '@tanstack/ai-gemini';
import { createOpenaiChat, OPENAI_CHAT_MODELS } from '@tanstack/ai-openai';
import { type } from 'arktype';
import { Hono, type MiddlewareHandler } from 'hono';
import { describeRoute } from 'hono-openapi';
import { requireBearerUser } from '../middleware/require-auth.js';
import { createRequireOwnership } from '../middleware/require-ownership.js';
import type { OwnershipRule } from '../ownership.js';
import type { Env } from '../types.js';

const chatOptions = type({
	'systemPrompts?': 'string[] | undefined',
	'temperature?': 'number | undefined',
	'maxTokens?': 'number | undefined',
	'topP?': 'number | undefined',
	'metadata?': 'Record<string, unknown> | undefined',
	'conversationId?': 'string | undefined',
	'tools?': 'object[] | undefined',
});

const aiChatBody = type({
	messages: 'object[] >= 1',
	data: chatOptions.merge(
		type.or(
			{ provider: "'openai'", model: type.enumerated(...OPENAI_CHAT_MODELS) },
			{ provider: "'gemini'", model: type.enumerated(...GeminiTextModels) },
		),
	),
	/** Caller-provided API key for BYOK. When present, the deployment's house key is bypassed. */
	'apiKey?': 'string | undefined',
});

/**
 * `/api/ai/chat` sub-app. Auth and ownership are wired by {@link mountAiApp};
 * credit policies are supplied by the deployment. Exported so the handler can
 * be exercised directly in tests; it is NOT re-exported from the package index,
 * so a deployment can only reach it through `mountAiApp` (auth bundled in).
 */
export const aiApp = new Hono<Env>().post(
	API_ROUTES.ai.chat.pattern,
	describeRoute({
		description: 'Stream AI chat completions via SSE',
		tags: ['ai'],
	}),
	sValidator('json', aiChatBody),
	async (c) => {
		const { messages, data, apiKey: userApiKey } = c.req.valid('json');
		const { provider, tools, ...options } = data;

		let adapter: AnyTextAdapter;
		switch (data.provider) {
			case 'openai': {
				const apiKey = userApiKey ?? c.env.OPENAI_API_KEY;
				if (!apiKey) {
					return c.json(
						AiChatError.ProviderNotConfigured({ provider }),
						AiChatErrorStatus.ProviderNotConfigured,
					);
				}
				adapter = createOpenaiChat(data.model, apiKey);
				break;
			}
			case 'gemini': {
				const apiKey = userApiKey ?? c.env.GEMINI_API_KEY;
				if (!apiKey) {
					return c.json(
						AiChatError.ProviderNotConfigured({ provider }),
						AiChatErrorStatus.ProviderNotConfigured,
					);
				}
				adapter = createGeminiChat(data.model, apiKey);
				break;
			}
			default:
				return data satisfies never;
		}

		const abortController = new AbortController();
		const stream = chat({
			adapter,
			messages: messages as Array<ModelMessage>,
			...options,
			tools: tools as Array<Tool> | undefined,
			abortController,
		});

		return toServerSentEventsResponse(stream, { abortController });
	},
);

/**
 * Mount the AI surface on a deployment's server app.
 *
 * Bundles bearer auth, the ownership rule, any deployment policies (cloud
 * passes `[chargeAiCreditsWithAutumn]`), and the route mount into one call.
 * Like rooms, AI chat is for external clients only, so auth is bearer-only and
 * fixed here rather than a deployment knob.
 *
 * `ownership` runs right after auth, so the AI route shares the same
 * authorization boundary as rooms and assets: in team mode the deployment's
 * `isMember` predicate gates the route (a non-member gets 403 before any
 * provider call), and in personal mode it resolves to the caller's own
 * partition. Authenticating the caller is not enough on a team deployment, or
 * any signed-in user could spend the deployment's AI budget.
 *
 * The library remains billing-agnostic: policies are opaque middleware
 * that run after auth and ownership and may short-circuit the request (e.g.
 * 402 insufficient credits) before the AI handler streams.
 *
 * Policies are typed loosely (`MiddlewareHandler`) so deployments that
 * extend the library `Env` with their own `Variables` can pass policies
 * without an unsafe cast. At runtime they execute against the deployment's
 * wider Context, so they are safe regardless of declared Env shape.
 */
export function mountAiApp(
	app: Hono<Env>,
	opts: {
		ownership: OwnershipRule;
		policies?: MiddlewareHandler[];
	},
): void {
	const policies = opts.policies ?? [];
	app.use(
		API_ROUTES.ai.chat.prefixPattern,
		requireBearerUser,
		createRequireOwnership(opts.ownership),
		...policies,
	);
	app.route('/', aiApp);
}
