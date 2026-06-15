/**
 * Pins the `defineErrors` + `AiChatErrorStatus` side-map contract:
 *
 *   - `AiChatErrorStatus` holds the per-variant HTTP status as literal types.
 *   - The serialized error body MUST NOT include `status`.
 *   - The Hono route returns the side-map status as the HTTP status.
 *   - `error.name` narrows to variant-specific fields.
 */

import { describe, expect, expectTypeOf, test } from 'bun:test';
import {
	AiChatError,
	AiChatErrorStatus,
} from '@epicenter/constants/ai-chat-errors';
import { API_ROUTES } from '@epicenter/constants/api-routes';
import { Hono } from 'hono';
import { shared } from '../ownership.js';
import type { Env } from '../types.js';
import { mountAiApp } from './ai.js';

describe('AiChatErrorStatus side-map', () => {
	test('holds the correct literal status for each variant', () => {
		expect(AiChatErrorStatus.Unauthorized).toBe(401);
		expect(AiChatErrorStatus.ProviderNotConfigured).toBe(503);
		expect(AiChatErrorStatus.UnknownModel).toBe(400);
		expect(AiChatErrorStatus.InsufficientCredits).toBe(402);
		expect(AiChatErrorStatus.ModelRequiresPaidPlan).toBe(403);

		expectTypeOf(AiChatErrorStatus.Unauthorized).toEqualTypeOf<401>();
		expectTypeOf(AiChatErrorStatus.ProviderNotConfigured).toEqualTypeOf<503>();
		expectTypeOf(AiChatErrorStatus.InsufficientCredits).toEqualTypeOf<402>();
	});

	test('factory returns Err envelope without a status field in the body', () => {
		const result = AiChatError.ProviderNotConfigured({ provider: 'openai' });

		expect(result).toEqual({
			data: null,
			error: {
				name: 'ProviderNotConfigured',
				message: 'openai not configured',
				provider: 'openai',
			},
		});
		expect(result.error).not.toHaveProperty('status');
	});

	test('every variant body lacks a status field', () => {
		const bodies = [
			AiChatError.Unauthorized().error,
			AiChatError.ProviderNotConfigured({ provider: 'gemini' }).error,
			AiChatError.UnknownModel({ model: 'gpt-99' }).error,
			AiChatError.InsufficientCredits({ balance: 0 }).error,
			AiChatError.ModelRequiresPaidPlan({ model: 'opus', credits: 100 }).error,
		];
		for (const body of bodies) {
			expect(body).not.toHaveProperty('status');
		}
	});

	test('client-side narrowing by error.name surfaces variant fields', () => {
		type AiChatErrorBody = ReturnType<
			typeof AiChatError.ProviderNotConfigured
		>['error'];

		function inspect(body: AiChatErrorBody | { name: 'Unauthorized' }) {
			switch (body.name) {
				case 'ProviderNotConfigured':
					expectTypeOf(body.provider).toEqualTypeOf<string>();
					return body.provider;
				case 'Unauthorized':
					return 'unauth';
			}
		}

		const body = AiChatError.ProviderNotConfigured({
			provider: 'openai',
		}).error;
		expect(inspect(body)).toBe('openai');
	});
});

describe('AI chat route HTTP responses', () => {
	function createTestApp(ownership = shared({ admit: () => true })) {
		const app = new Hono<Env>();
		mountAiApp(app, {
			// Permissive auth for the slice we're testing; the route reaches
			// the ProviderNotConfigured branch before any policy runs.
			auth: async (_c, next) => next(),
			ownership,
		});
		return app;
	}

	test('returns 503 with ProviderNotConfigured body when OPENAI_API_KEY missing', async () => {
		const app = createTestApp();
		const res = await app.request(
			API_ROUTES.ai.chat.pattern,
			{
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					messages: [{ role: 'user', content: 'hi' }],
					data: { model: 'gpt-5.4-mini' },
				}),
			},
			// No env: OPENAI_API_KEY is undefined.
			{},
		);

		expect(res.status).toBe(AiChatErrorStatus.ProviderNotConfigured);
		expect(res.status).toBe(503);

		const body = (await res.json()) as {
			data: null;
			error: { name: string; message: string; provider: string };
		};
		expect(body.error.name).toBe('ProviderNotConfigured');
		expect(body.error.provider).toBe('openai');
		expect(body.error).not.toHaveProperty('status');
	});

	test('doc route rejects a malformed guid with 400 before touching any room', async () => {
		const app = createTestApp();
		const res = await app.request(
			API_ROUTES.ai.chatDoc.pattern,
			{
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					guid: 'not a doc guid',
					generationId: 'gen-1',
					data: { model: 'gpt-5.4-mini' },
				}),
			},
			{ OPENAI_API_KEY: 'sk-test' },
		);

		expect(res.status).toBe(400);
	});

	test('doc route returns 503 ProviderNotConfigured when the house key is missing', async () => {
		const app = createTestApp();
		const res = await app.request(
			API_ROUTES.ai.chatDoc.pattern,
			{
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					guid: 'epicenter-zhongwen.conversations.abc123.messages',
					generationId: 'gen-1',
					data: { model: 'gpt-5.4-mini' },
				}),
			},
			// No env: OPENAI_API_KEY is undefined; fails before any room access.
			{},
		);

		expect(res.status).toBe(AiChatErrorStatus.ProviderNotConfigured);
		const body = (await res.json()) as { error: { name: string } };
		expect(body.error.name).toBe('ProviderNotConfigured');
	});

	test('shared mode rejects a non-admitted user with 403 NotAdmitted before any AI key is read', async () => {
		const app = createTestApp(shared({ admit: () => false }));
		const res = await app.request(
			API_ROUTES.ai.chat.pattern,
			{
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					messages: [{ role: 'user', content: 'hi' }],
					data: { model: 'gpt-5.4-mini' },
				}),
			},
			// A house key IS configured; admission must fail first so it is never read.
			{ OPENAI_API_KEY: 'sk-must-never-be-read' },
		);

		expect(res.status).toBe(403);
		const body = (await res.json()) as { error: { name: string } };
		expect(body.error.name).toBe('NotAdmitted');
	});
});
