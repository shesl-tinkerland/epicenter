/**
 * `/api/ai` sub-app: AI chat across OpenAI and Gemini over one transport.
 *
 *   - `/api/ai/chat`  SSE streaming; history arrives in the POST body, tokens
 *                     stream back over the open HTTP connection.
 *
 * This is a stateless, metered inference stream: it sees a prompt and returns
 * tokens, and it never reads or writes a conversation doc (ADR-0033). A
 * conversation is a synced doc written only by an in-process peer (a browser tab
 * or a daemon); the cloud is a blind relay plus this token stream. The browser's
 * Epicenter provider posts here for house-key inference and writes the tokens
 * into its own local doc, which syncs to every device.
 *
 * Tool-calling chat runs the tools in the client against its local workspace,
 * with mutations waiting on human approval mid-turn; the client drives that loop
 * and this route is only its inference backend.
 *
 * Library-side, billing-free. The deployment composes any plan or credit
 * gating in front of this app via `mountAiApp`'s `policies`. apps/api passes
 * `chargeAiCreditsWithAutumn` (reserve -> 402 -> confirm in this one request);
 * a self-hosted shared-wiki deployment passes no policies. The body carries
 * `data.model`, which the billing policy reads; the provider is derived from the
 * catalog.
 *
 * BYOK: callers may pass `apiKey` in the request body, in which case the
 * deployment's provider key is ignored. No billing implications; the
 * library treats BYOK and house-key the same.
 *
 * House keys (`OPENAI_API_KEY`, `GEMINI_API_KEY`) are optional bindings: a
 * deployment that omits one serves only BYOK requests for that provider,
 * and a house-key request gets 503 ProviderNotConfigured. Hosted requires
 * both at deploy time; see apps/api/wrangler.jsonc for why.
 */

import {
	createAdapterForModel,
	HOUSE_KEY_ENV_VAR,
} from '@epicenter/ai-adapters';
import {
	AiChatError,
	AiChatErrorStatus,
} from '@epicenter/constants/ai-chat-errors';
import {
	MODELS_BY_ID,
	SERVABLE_MODELS,
	type ServableModel,
} from '@epicenter/constants/ai-providers';
import { API_ROUTES } from '@epicenter/constants/api-routes';
import { sValidator } from '@hono/standard-validator';
import {
	type AnyTextAdapter,
	chat,
	type ModelMessage,
	type Tool,
	toServerSentEventsResponse,
} from '@tanstack/ai';
import { type } from 'arktype';
import { Hono, type MiddlewareHandler } from 'hono';
import { describeRoute } from 'hono-openapi';
import { Ok, type Result } from 'wellcrafted/result';
import { createRequireOwnership } from '../middleware/require-ownership.js';
import type { OwnershipRule } from '../ownership.js';
import type { Env } from '../types.js';

const chatOptions = type({
	'systemPrompts?': 'string[] | undefined',
	'temperature?': 'number | undefined',
	'maxTokens?': 'number | undefined',
	'topP?': 'number | undefined',
	'metadata?': 'Record<string, unknown> | undefined',
	'tools?': 'object[] | undefined',
});

// The body carries `model` only; the catalog owns the model -> provider
// mapping, so the client never asserts a provider and this route derives it
// (see `resolveAdapter`). Adding a model to the catalog makes it acceptable
// here automatically.
const modelChoice = type({
	model: type.enumerated(...SERVABLE_MODELS),
});

const aiChatBody = type({
	messages: 'object[] >= 1',
	data: chatOptions.merge(modelChoice),
	/** Caller-provided API key for BYOK. When present, the deployment's house key is bypassed. */
	'apiKey?': 'string | undefined',
});

/**
 * Resolve the provider adapter for a request: BYOK key wins, else the
 * deployment's house key, else `ProviderNotConfigured`. Exported so the catalog's
 * model -> provider switch stays in one place.
 */
export function resolveAdapter({
	model,
	userApiKey,
	env,
}: {
	model: ServableModel;
	userApiKey: string | undefined;
	env: { OPENAI_API_KEY?: string; GEMINI_API_KEY?: string };
}): Result<
	AnyTextAdapter,
	ReturnType<typeof AiChatError.ProviderNotConfigured>['error']
> {
	// Key policy stays here: BYOK wins, else the deployment's per-provider house
	// key, else `ProviderNotConfigured`. The env var that holds each house key is
	// single-homed in `@epicenter/ai-adapters`; adapter construction is delegated
	// there too.
	const entry = MODELS_BY_ID[model];
	const houseKey = env[HOUSE_KEY_ENV_VAR[entry.provider]];
	const apiKey = userApiKey ?? houseKey;
	if (!apiKey) {
		return AiChatError.ProviderNotConfigured({ provider: entry.provider });
	}
	return Ok(createAdapterForModel(model, apiKey));
}

/**
 * `/api/ai/chat` sub-app. Auth and credit policies are supplied by the
 * deployment via {@link mountAiApp}.
 */
const aiApp = new Hono<Env>().post(
	API_ROUTES.ai.chat.pattern,
	describeRoute({
		description: 'Stream AI chat completions via SSE',
		tags: ['ai'],
	}),
	sValidator('json', aiChatBody),
	async (c) => {
		const { messages, data, apiKey: userApiKey } = c.req.valid('json');
		const { model, tools, ...options } = data;

		const { data: adapter, error: adapterError } = resolveAdapter({
			model,
			userApiKey,
			env: c.env,
		});
		if (adapterError) {
			return c.json(
				{ data: null, error: adapterError },
				AiChatErrorStatus.ProviderNotConfigured,
			);
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
 * Bundles the deployment's chosen auth middleware (cloud uses
 * `requireBearerUser`; AI chat is for external clients only), the
 * deployment's ownership rule, any deployment policies (cloud passes
 * `[chargeAiCreditsWithAutumn]`), and the route mount into one call.
 *
 * The ownership rule gates ADMISSION, not partitioning: `/api/ai/chat`
 * carries no `:ownerId`, so `requireOwnership` resolves the partition and,
 * in shared mode, runs the deployment's `admit` predicate, rejecting a
 * non-member with 403 NotAdmitted before any house AI key is spent. In
 * personal mode it only stamps `c.var.ownerId`. This keeps AI behind the
 * same membership check as the wiki data surfaces.
 *
 * The library remains billing-agnostic: policies are opaque middleware
 * that run after auth and ownership and may short-circuit the request
 * (e.g. 402 insufficient credits) before the AI handler streams.
 *
 * Policies are typed loosely (`MiddlewareHandler`) so deployments that
 * extend the library `Env` with their own `Variables` can pass policies
 * without an unsafe cast. At runtime they execute against the deployment's
 * wider Context, so they are safe regardless of declared Env shape.
 */
export function mountAiApp(
	app: Hono<Env>,
	opts: {
		auth: MiddlewareHandler;
		ownership: OwnershipRule;
		policies?: MiddlewareHandler[];
	},
): void {
	const policies = opts.policies ?? [];
	app.use(
		API_ROUTES.ai.chat.prefixPattern,
		opts.auth,
		createRequireOwnership(opts.ownership),
		...policies,
	);
	app.route('/', aiApp);
}
