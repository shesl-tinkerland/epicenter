/**
 * `/v1/chat/completions`: the OpenAI-compatible inference gateway (ADR-0049,
 * ADR-0050). One swappable inference server speaking the OpenAI Chat Completions
 * wire. The client agent loop ({@link createOpenAiAgentEngine}) points at this by
 * base URL; pointing it elsewhere (Ollama, OpenRouter, a self-hosted gateway) is
 * configuration, not code.
 *
 * It is a thin reverse proxy: resolve the provider from the model catalog,
 * inject the key (BYOK from the body, else the deployment's house key), forward
 * to the provider's OpenAI-compatible endpoint, and stream the reply straight
 * back. OpenAI is pure passthrough. Gemini's compat endpoint streams tool calls
 * faithfully except it omits the `index` on `tool_calls` deltas, so this gateway
 * injects sequential indices (0, 1, 2, ...) on the way through, making the stream
 * spec-compliant for any OpenAI client (verified, Wave 1; the canonical LiteLLM
 * fix). The gateway never executes a tool and keeps no transcript: it is a
 * stateless inference turn (ADR-0049).
 *
 * Like `/api/ai/chat`, this is library-side and billing-agnostic. Auth,
 * ownership, and any credit policy are supplied by the deployment through
 * {@link mountInferenceApp}: apps/api passes its Autumn metering policy, a
 * self-hosted shared-wiki deployment passes none. BYOK (an `apiKey` in the body)
 * bypasses the house key and, by convention, the deployment's metering policy.
 *
 * Error convention (OpenAI shape, so the client reducer keeps its branchable
 * `error.code`): every failure answers `{ error: { message, code } }`.
 *   - 400 `UnknownModel`           the model is not in the catalog.
 *   - 400 `invalid_request`        the body is malformed.
 *   - 503 `ProviderNotConfigured`  no BYOK key and no house key for the provider.
 *   - 402 `InsufficientCredits`    the deployment's metering policy (apps/api).
 *   - 401 `Unauthorized`           the deployment's auth middleware.
 *   - upstream non-2xx             the provider's own OpenAI-shaped error, with
 *                                  its status, forwarded verbatim.
 *   - 502 `upstream_unreachable`   the provider could not be reached.
 * A mid-stream provider failure arrives as an error frame inside the SSE body,
 * already in the OpenAI shape; the client surfaces it as a `run-error` chunk.
 */

import {
	type AiProvider,
	MODELS_BY_ID,
	type ServableModel,
} from '@epicenter/constants/ai-providers';
import { API_ROUTES } from '@epicenter/constants/api-routes';
import { Hono, type MiddlewareHandler } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { describeRoute } from 'hono-openapi';
import { extractErrorMessage } from 'wellcrafted/error';
import { createRequireOwnership } from '../middleware/require-ownership.js';
import type { OwnershipRule } from '../ownership.js';
import type { Env } from '../types.js';

/**
 * Per-provider routing facts for the gateway: the OpenAI-compatible base URL and
 * the deployment env var holding the house key. The model catalog
 * (`MODELS_BY_ID`) owns model -> provider; this owns provider -> upstream. Kept
 * local to the gateway (ADR-0050: the provider-routing fact lives here, not in a
 * shared SDK-adapter leaf).
 */
const PROVIDER_UPSTREAM = {
	openai: {
		baseURL: 'https://api.openai.com/v1',
		houseKeyEnv: 'OPENAI_API_KEY',
	},
	gemini: {
		baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
		houseKeyEnv: 'GEMINI_API_KEY',
	},
} as const satisfies Record<
	AiProvider,
	{ baseURL: string; houseKeyEnv: 'OPENAI_API_KEY' | 'GEMINI_API_KEY' }
>;

/** Build the OpenAI error envelope every gateway failure answers with. */
function openAiError(
	message: string,
	code: string,
): { error: { message: string; code: string } } {
	return { error: { message, code } };
}

/** Clamp an upstream status to a forwardable client/server error code. */
function clampStatus(status: number): ContentfulStatusCode {
	if (status >= 400 && status <= 599) return status as ContentfulStatusCode;
	return 502;
}

/**
 * Rewrite a Gemini SSE stream to inject sequential `tool_calls` indices. Gemini's
 * compat endpoint sends each parallel call complete in one delta but omits the
 * `index`; OpenAI clients correlate calls by index, so a missing index would
 * merge parallel calls. We assign 0, 1, 2, ... to each index-less tool-call delta
 * as it streams. OpenAI's own stream already carries indices and never reaches
 * here. Frames are double-newline separated; a non-`data` line, `[DONE]`, or an
 * unparseable frame passes through untouched.
 */
function injectToolCallIndices(
	body: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
	const decoder = new TextDecoder();
	const encoder = new TextEncoder();
	let buffer = '';
	let nextIndex = 0;

	function rewriteFrame(frame: string): string {
		return frame
			.split('\n')
			.map((line) => {
				if (!line.startsWith('data:')) return line;
				const data = line.slice('data:'.length).trimStart();
				if (data === '' || data === '[DONE]') return line;
				let parsed: {
					choices?: Array<{
						delta?: { tool_calls?: Array<{ index?: number }> };
					}>;
				};
				try {
					parsed = JSON.parse(data);
				} catch {
					return line;
				}
				let mutated = false;
				for (const choice of parsed.choices ?? []) {
					const toolCalls = choice.delta?.tool_calls;
					if (!Array.isArray(toolCalls)) continue;
					for (const toolCall of toolCalls) {
						if (typeof toolCall.index !== 'number') {
							toolCall.index = nextIndex++;
							mutated = true;
						}
					}
				}
				return mutated ? `data: ${JSON.stringify(parsed)}` : line;
			})
			.join('\n');
	}

	return body.pipeThrough(
		new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, controller) {
				buffer += decoder.decode(chunk, { stream: true });
				const frames = buffer.split('\n\n');
				buffer = frames.pop() ?? '';
				for (const frame of frames) {
					controller.enqueue(encoder.encode(`${rewriteFrame(frame)}\n\n`));
				}
			},
			flush(controller) {
				if (buffer.length > 0) {
					controller.enqueue(encoder.encode(rewriteFrame(buffer)));
				}
			},
		}),
	);
}

const inferenceApp = new Hono<Env>().post(
	API_ROUTES.ai.completions.pattern,
	describeRoute({
		description: 'OpenAI-compatible Chat Completions inference gateway',
		tags: ['ai'],
	}),
	async (c) => {
		const raw = await c.req.json().catch(() => null);
		if (!raw || typeof raw !== 'object') {
			return c.json(
				openAiError('Invalid request body.', 'invalid_request'),
				400,
			);
		}
		const body = raw as Record<string, unknown>;

		const model = body.model;
		if (typeof model !== 'string' || !(model in MODELS_BY_ID)) {
			return c.json(
				openAiError(`Unknown model: ${String(model)}`, 'UnknownModel'),
				400,
			);
		}
		if (!Array.isArray(body.messages) || body.messages.length === 0) {
			return c.json(
				openAiError('messages must be a non-empty array.', 'invalid_request'),
				400,
			);
		}

		const { provider } = MODELS_BY_ID[model as ServableModel];
		const upstream = PROVIDER_UPSTREAM[provider];
		const byokKey =
			typeof body.apiKey === 'string' && body.apiKey.length > 0
				? body.apiKey
				: undefined;
		const houseKey = c.env[upstream.houseKeyEnv];
		const apiKey = byokKey ?? houseKey;
		if (!apiKey) {
			return c.json(
				openAiError(`${provider} is not configured.`, 'ProviderNotConfigured'),
				503,
			);
		}

		// Forward the body verbatim minus the BYOK key (the provider never sees it).
		const { apiKey: _omitApiKey, ...forwardBody } = body;

		let upstreamResponse: Response;
		try {
			upstreamResponse = await fetch(`${upstream.baseURL}/chat/completions`, {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					authorization: `Bearer ${apiKey}`,
				},
				body: JSON.stringify(forwardBody),
				signal: c.req.raw.signal,
			});
		} catch (error) {
			return c.json(
				openAiError(extractErrorMessage(error), 'upstream_unreachable'),
				502,
			);
		}

		if (!upstreamResponse.ok || !upstreamResponse.body) {
			// OpenAI and Gemini-compat answer errors in the OpenAI shape; forward the
			// provider's body verbatim with its status when it parses, else wrap it.
			const text = await upstreamResponse.text().catch(() => '');
			const status = clampStatus(upstreamResponse.status);
			let payload: unknown;
			try {
				payload = JSON.parse(text);
			} catch {
				payload = null;
			}
			if (payload && typeof payload === 'object' && 'error' in payload) {
				return c.json(payload as Record<string, unknown>, status);
			}
			return c.json(
				openAiError(
					text || `Upstream returned ${upstreamResponse.status}.`,
					'upstream_error',
				),
				status,
			);
		}

		const stream =
			provider === 'gemini'
				? injectToolCallIndices(upstreamResponse.body)
				: upstreamResponse.body;

		return new Response(stream, {
			status: 200,
			headers: {
				'content-type': 'text/event-stream',
				'cache-control': 'no-cache',
			},
		});
	},
);

/**
 * Mount the OpenAI-compatible inference gateway on a deployment's server app.
 *
 * Like the other mount primitives, it bundles the deployment's auth, its
 * ownership rule (admission, gating a house-key spend behind membership in
 * shared mode),
 * and any deployment policies (apps/api passes its Autumn metering policy; a
 * self-hosted shared-wiki deployment passes none). The library stays
 * billing-agnostic; policies are opaque middleware that run after auth and
 * ownership and may short-circuit (e.g. 402) before the gateway streams.
 */
export function mountInferenceApp(
	app: Hono<Env>,
	opts: {
		auth: MiddlewareHandler;
		ownership: OwnershipRule;
		policies?: MiddlewareHandler[];
	},
): void {
	const policies = opts.policies ?? [];
	app.use(
		API_ROUTES.ai.completions.prefixPattern,
		opts.auth,
		createRequireOwnership(opts.ownership),
		...policies,
	);
	app.route('/', inferenceApp);
}
