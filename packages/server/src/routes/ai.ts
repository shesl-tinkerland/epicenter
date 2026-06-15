/**
 * `/api/ai` sub-app: AI chat across OpenAI and Gemini, over two transports.
 *
 *   - `/api/ai/chat`      SSE streaming; history arrives in the POST body.
 *   - `/api/ai/chat/doc`  Doc-as-wire; history lives in a synced Yjs
 *                         conversation doc and the server streams assistant
 *                         tokens into it as a sync peer (see
 *                         `../ai/doc-generation.ts`). The request stays open
 *                         for the whole generation; aborting it cancels.
 *
 * The two transports are not interchangeable, and SSE is not legacy. SSE
 * carries interactive tool-calling chat: tools run in the client against its
 * local workspace and mutations wait on human approval mid-turn. A doc-as-wire
 * sync peer cannot express that, because the actor snapshots the prompt once,
 * writes as the single owner of the assistant message, and never reads the doc
 * back mid-generation. Doc-as-wire is for server-authored text streamed into a
 * synced doc (cross-device continuity, background completion). Folding SSE onto
 * doc-as-wire would mean rebuilding client tool execution and approval as a
 * two-writer doc protocol, a different and harder primitive.
 *
 * Library-side, billing-free. The deployment composes any plan or credit
 * gating in front of this app via `mountAiApp`'s `policies`. apps/api
 * passes `chargeAiCreditsWithAutumn`; a self-hosted shared-wiki deployment
 * passes no policies. Both routes carry `data.model` in the body, which is
 * what the billing policy reads; the provider is derived from the catalog.
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
import { createGeminiChat } from '@tanstack/ai-gemini';
import { createOpenaiChat } from '@tanstack/ai-openai';
import { type } from 'arktype';
import { Hono, type MiddlewareHandler } from 'hono';
import { describeRoute } from 'hono-openapi';
import { Ok, type Result } from 'wellcrafted/result';
import { runDocGeneration } from '../ai/doc-generation.js';
import { createRequireOwnership } from '../middleware/require-ownership.js';
import { doName } from '../owner.js';
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
 * Canonical content-doc guid grammar: four dot-separated safe segments
 * (`workspaceId.collection.rowId.field`, see `docGuid` in
 * `@epicenter/workspace`). Ownership scoping happens upstream via
 * `doName(ownerId, guid)`; this only rejects strings that could never name
 * a content doc.
 */
const DOC_GUID_REGEX =
	/^[a-z0-9]+(?:-[a-z0-9]+)*(?:\.[a-z0-9]+(?:-[a-z0-9]+)*){3}$/;

const aiChatDocBody = type({
	guid: type('string').narrow((s) => DOC_GUID_REGEX.test(s)),
	/** Client-minted; doubles as the assistant message id for idempotency. */
	generationId: 'string > 0',
	// Same options as the SSE route minus `tools` (doc-as-wire chat is
	// text-only) and minus `messages` (history lives in the doc).
	data: chatOptions.omit('tools').merge(modelChoice),
	/** Caller-provided API key for BYOK. When present, the deployment's house key is bypassed. */
	'apiKey?': 'string | undefined',
});

/**
 * Resolve the provider adapter for a request: BYOK key wins, else the
 * deployment's house key, else `ProviderNotConfigured`.
 */
function resolveAdapter({
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
	// The catalog entry is discriminated on `provider`, so this switch narrows
	// `entry.id` to the matching SDK model union: each adapter call is typed
	// with no cast.
	const entry = MODELS_BY_ID[model];
	switch (entry.provider) {
		case 'openai': {
			const apiKey = userApiKey ?? env.OPENAI_API_KEY;
			if (!apiKey) {
				return AiChatError.ProviderNotConfigured({ provider: entry.provider });
			}
			return Ok(createOpenaiChat(entry.id, apiKey));
		}
		case 'gemini': {
			const apiKey = userApiKey ?? env.GEMINI_API_KEY;
			if (!apiKey) {
				return AiChatError.ProviderNotConfigured({ provider: entry.provider });
			}
			return Ok(createGeminiChat(entry.id, apiKey));
		}
		default:
			return entry satisfies never;
	}
}

/**
 * `/api/ai/chat` sub-app. Auth and credit policies are supplied by the
 * deployment via {@link mountAiApp}.
 */
const aiApp = new Hono<Env>()
	.post(
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
	)
	.post(
		API_ROUTES.ai.chatDoc.pattern,
		describeRoute({
			description:
				'Generate an AI chat turn into a synced Yjs conversation doc',
			tags: ['ai'],
		}),
		sValidator('json', aiChatDocBody),
		async (c) => {
			const {
				guid,
				generationId,
				data,
				apiKey: userApiKey,
			} = c.req.valid('json');
			const { model, ...options } = data;

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

			const room = c.var.rooms.get(doName(c.var.ownerId, guid));

			// Stop = the client aborting this fetch. Forward the request
			// signal so the provider stream cancels and the actor writes
			// `finish: cancelled` (its final sync rides ctx.waitUntil).
			const abortController = new AbortController();
			const requestSignal = c.req.raw.signal;
			if (requestSignal.aborted) abortController.abort();
			else
				requestSignal.addEventListener('abort', () => abortController.abort());

			const { data: generation, error } = await runDocGeneration({
				room,
				generationId,
				signal: abortController.signal,
				waitUntil: (promise) => c.executionCtx.waitUntil(promise),
				startStream: (messages) =>
					chat({ adapter, messages, ...options, abortController }),
			});
			if (error) {
				return c.json({ data: null, error }, AiChatErrorStatus[error.name]);
			}
			return c.json({ data: generation, error: null });
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
