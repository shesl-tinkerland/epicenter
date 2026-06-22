/**
 * The OpenAI-compatible inference gateway: provider routing, key resolution
 * (BYOK vs house), OpenAI passthrough, the Gemini `tool_calls` index injection
 * (the Wave 1 gate), and the OpenAI error convention. The upstream provider call
 * is the global `fetch`, stubbed here to a canned SSE response so the gateway is
 * exercised without a network.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { API_ROUTES } from '@epicenter/constants/api-routes';
import { Hono } from 'hono';
import { shared } from '../ownership.js';
import type { Env } from '../types.js';
import { mountInferenceApp } from './inference.js';

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

/** Build an OpenAI SSE body: one `data:` frame per chunk, then `[DONE]`. */
function sse(chunks: object[]): string {
	return `${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('')}data: [DONE]\n\n`;
}

type UpstreamCall = {
	url: string;
	headers: Record<string, string>;
	body: string;
};

/** Stub the upstream provider `fetch`, recording each call. */
function stubUpstream(response: Response): UpstreamCall[] {
	const calls: UpstreamCall[] = [];
	globalThis.fetch = (async (
		url: string | URL | Request,
		init?: RequestInit,
	) => {
		calls.push({
			url: String(url),
			headers: (init?.headers ?? {}) as Record<string, string>,
			body: String(init?.body ?? ''),
		});
		return response;
	}) as typeof globalThis.fetch;
	return calls;
}

function createTestApp() {
	const app = new Hono<Env>();
	mountInferenceApp(app, {
		// Permissive auth for the slice under test; admission passes too.
		auth: async (_c, next) => next(),
		ownership: shared({ admit: () => true }),
	});
	return app;
}

async function post(
	app: Hono<Env>,
	body: object,
	env: Record<string, unknown>,
): Promise<Response> {
	return app.request(
		API_ROUTES.ai.completions.pattern,
		{
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body),
		},
		env,
	);
}

/** Parse the streamed `data:` frames out of an SSE response body. */
function parseFrames(text: string): Array<Record<string, unknown>> {
	return text
		.split('\n\n')
		.map((frame) => frame.split('\n').find((l) => l.startsWith('data:')))
		.filter((line): line is string => Boolean(line))
		.map((line) => line.slice('data:'.length).trim())
		.filter((data) => data !== '' && data !== '[DONE]')
		.map((data) => JSON.parse(data) as Record<string, unknown>);
}

describe('inference gateway', () => {
	test('answers ProviderNotConfigured in the OpenAI error shape when no key is available', async () => {
		const res = await post(
			createTestApp(),
			{ model: 'gpt-5.4-mini', messages: [{ role: 'user', content: 'hi' }] },
			{}, // no house key, no BYOK
		);
		expect(res.status).toBe(503);
		const body = (await res.json()) as { error: { code: string } };
		expect(body.error.code).toBe('ProviderNotConfigured');
	});

	test('rejects an unknown model with a 400 UnknownModel', async () => {
		const res = await post(
			createTestApp(),
			{ model: 'gpt-99', messages: [{ role: 'user', content: 'hi' }] },
			{ OPENAI_API_KEY: 'sk-house' },
		);
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: { code: string } };
		expect(body.error.code).toBe('UnknownModel');
	});

	test('OpenAI: forwards to the OpenAI endpoint, uses the BYOK key, strips it from the body, streams back', async () => {
		const calls = stubUpstream(
			new Response(
				sse([
					{ choices: [{ delta: { content: 'hi' }, finish_reason: 'stop' }] },
				]),
				{ status: 200, headers: { 'content-type': 'text/event-stream' } },
			),
		);
		const res = await post(
			createTestApp(),
			{
				model: 'gpt-5.5',
				messages: [{ role: 'user', content: 'hi' }],
				apiKey: 'sk-byok',
			},
			{}, // BYOK means no house key needed
		);
		expect(res.status).toBe(200);
		expect(await res.text()).toContain('"content":"hi"');

		expect(calls[0]?.url).toBe('https://api.openai.com/v1/chat/completions');
		expect(calls[0]?.headers.authorization).toBe('Bearer sk-byok');
		const forwarded = JSON.parse(calls[0]?.body ?? '{}');
		expect('apiKey' in forwarded).toBe(false);
		expect(forwarded.model).toBe('gpt-5.5');
	});

	test('Gemini: routes to the compat endpoint and injects sequential tool_calls indices', async () => {
		const calls = stubUpstream(
			new Response(
				sse([
					{
						choices: [
							{
								delta: {
									tool_calls: [
										{
											id: 'call_a',
											type: 'function',
											function: {
												name: 'get_weather',
												arguments: '{"city":"Paris"}',
											},
										},
									],
								},
								finish_reason: null,
							},
						],
					},
					{
						choices: [
							{
								delta: {
									tool_calls: [
										{
											id: 'call_b',
											type: 'function',
											function: {
												name: 'get_weather',
												arguments: '{"city":"Tokyo"}',
											},
										},
									],
								},
								// Gemini sometimes finishes 'stop' while emitting a tool call.
								finish_reason: 'stop',
							},
						],
					},
				]),
				{ status: 200, headers: { 'content-type': 'text/event-stream' } },
			),
		);
		const res = await post(
			createTestApp(),
			{
				model: 'gemini-3.5-flash',
				messages: [{ role: 'user', content: 'go' }],
			},
			{ GEMINI_API_KEY: 'g-house' },
		);
		expect(res.status).toBe(200);

		const frames = parseFrames(await res.text());
		const indices = frames.flatMap((frame) => {
			const choice = (frame.choices as Array<Record<string, unknown>>)?.[0];
			const delta = choice?.delta as
				| { tool_calls?: Array<{ index?: number }> }
				| undefined;
			return (delta?.tool_calls ?? []).map((call) => call.index);
		});
		expect(indices).toEqual([0, 1]);

		expect(calls[0]?.url).toBe(
			'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
		);
		expect(calls[0]?.headers.authorization).toBe('Bearer g-house');
	});

	test('OpenAI stream passes through untouched (indices preserved, not reassigned)', async () => {
		const upstream = sse([
			{
				choices: [
					{
						delta: {
							tool_calls: [
								{
									index: 0,
									id: 'c0',
									function: { name: 'a', arguments: '{}' },
								},
								{
									index: 1,
									id: 'c1',
									function: { name: 'b', arguments: '{}' },
								},
							],
						},
						finish_reason: 'tool_calls',
					},
				],
			},
		]);
		stubUpstream(
			new Response(upstream, {
				status: 200,
				headers: { 'content-type': 'text/event-stream' },
			}),
		);
		const res = await post(
			createTestApp(),
			{ model: 'gpt-5.5', messages: [{ role: 'user', content: 'go' }] },
			{ OPENAI_API_KEY: 'sk-house' },
		);
		expect(await res.text()).toBe(upstream);
	});

	test('forwards an upstream OpenAI-shaped error with its status', async () => {
		stubUpstream(
			new Response(
				JSON.stringify({
					error: { message: 'rate limited', code: 'rate_limit_exceeded' },
				}),
				{ status: 429, headers: { 'content-type': 'application/json' } },
			),
		);
		const res = await post(
			createTestApp(),
			{ model: 'gpt-5.5', messages: [{ role: 'user', content: 'hi' }] },
			{ OPENAI_API_KEY: 'sk-house' },
		);
		expect(res.status).toBe(429);
		const body = (await res.json()) as { error: { code: string } };
		expect(body.error.code).toBe('rate_limit_exceeded');
	});
});
