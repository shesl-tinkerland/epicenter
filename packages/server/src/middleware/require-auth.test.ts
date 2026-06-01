/**
 * Bearer auth middleware integration tests.
 *
 * Drives `requireBearerUser` through a real Hono app with a real Better Auth
 * server hosted on Bun.serve. Covers the production paths:
 *
 * - valid token resolves to the calling user on `c.var.user`
 * - token issued for the wrong audience returns 401 InvalidToken
 * - token whose user no longer exists returns 401 InvalidToken
 * - signing keys unreachable returns 503 ServerError (retryable, not a 401)
 *
 * Header parsing for the bearer scheme lives in `auth/parse-bearer.test.ts`.
 * HTTP and WebSocket failure response shape lives in `auth/oauth-resource.test.ts`.
 */

import { expect, test } from 'bun:test';
import { oauthProvider } from '@better-auth/oauth-provider';
import { EPICENTER_OAUTH_SCOPES } from '@epicenter/constants/oauth';
import { betterAuth } from 'better-auth';
import { type MemoryDB, memoryAdapter } from 'better-auth/adapters/memory';
import { jwt } from 'better-auth/plugins';
import { Hono } from 'hono';
import {
	createOAuthTestDb,
	isAddressInUse,
	issueOAuthTokens,
	randomOAuthTestPort,
} from '../test-helpers/oauth.js';
import type { Env } from '../types.js';
import { requireBearerUser } from './require-auth.js';

test('requireBearerUser resolves a valid API-audience token to c.var.user', async () => {
	const setup = createMiddlewareTestServer();
	try {
		const { accessToken } = await issueOAuthTokens(setup, {
			clientName: 'Bearer Middleware Test',
			email: 'middleware-test@example.com',
			name: 'Middleware Test',
		});

		const response = await setup.app.request('/protected', {
			headers: { authorization: `Bearer ${accessToken}` },
		});

		expect(response.status).toBe(200);
		const body = (await response.json()) as { id: string; email: string };
		expect(body).toEqual({
			id: expect.any(String),
			email: 'middleware-test@example.com',
		});
	} finally {
		setup.server.stop(true);
	}
});

test('requireBearerUser rejects tokens issued for the wrong audience with 401 InvalidToken', async () => {
	const setup = createMiddlewareTestServer();
	try {
		const { accessToken } = await issueOAuthTokens(setup, {
			clientName: 'Bearer Middleware Test',
			email: 'middleware-test@example.com',
			name: 'Middleware Test',
			resource: setup.wrongAudience,
		});

		const response = await setup.app.request('/protected', {
			headers: { authorization: `Bearer ${accessToken}` },
		});

		expect(response.status).toBe(401);
		expect(response.headers.get('WWW-Authenticate')).toBe(
			'Bearer error="invalid_token"',
		);
		const body = (await response.json()) as { name: string };
		expect(body.name).toBe('InvalidToken');
	} finally {
		setup.server.stop(true);
	}
});

test('requireBearerUser rejects tokens whose user no longer exists with 401 InvalidToken', async () => {
	const setup = createMiddlewareTestServer();
	try {
		const { accessToken } = await issueOAuthTokens(setup, {
			clientName: 'Bearer Middleware Test',
			email: 'middleware-test@example.com',
			name: 'Middleware Test',
		});
		setup.db.user = [];

		const response = await setup.app.request('/protected', {
			headers: { authorization: `Bearer ${accessToken}` },
		});

		expect(response.status).toBe(401);
		const body = (await response.json()) as { name: string };
		expect(body.name).toBe('InvalidToken');
	} finally {
		setup.server.stop(true);
	}
});

test('requireBearerUser returns 503 ServerError when the signing keys are unreachable', async () => {
	const setup = createMiddlewareTestServer();
	try {
		const { accessToken } = await issueOAuthTokens(setup, {
			clientName: 'Bearer Middleware Test',
			email: 'middleware-test@example.com',
			name: 'Middleware Test',
		});

		const response = await setup.app.request('/keys-unreadable', {
			headers: { authorization: `Bearer ${accessToken}` },
		});

		expect(response.status).toBe(503);
		expect(response.headers.get('WWW-Authenticate')).toBeNull();
		const body = (await response.json()) as { name: string };
		expect(body.name).toBe('ServerError');
	} finally {
		setup.server.stop(true);
	}
});

function createMiddlewareTestServer() {
	const db = createOAuthTestDb();

	for (let attempt = 0; attempt < 200; attempt += 1) {
		const port = randomOAuthTestPort();
		const baseURL = `http://localhost:${port}`;
		const wrongAudience = `${baseURL}/other-resource`;
		const auth = betterAuth({
			database: memoryAdapter(db),
			emailAndPassword: { enabled: true },
			basePath: '/auth',
			baseURL,
			secret: 'test-secret-test-secret-test-secret',
			plugins: [
				jwt(),
				oauthProvider({
					loginPage: '/sign-in',
					consentPage: '/consent',
					requirePKCE: true,
					validAudiences: [baseURL, wrongAudience],
					allowDynamicClientRegistration: false,
					scopes: [...EPICENTER_OAUTH_SCOPES],
					silenceWarnings: { oauthAuthServerConfig: true, openidConfig: true },
				}),
			],
		});

		try {
			const server = Bun.serve({
				port,
				fetch: async (request) => auth.handler(request),
			});

			const app = new Hono<Env>()
				.use('*', async (c, next) => {
					c.set('db', createFakeDb(db));
					c.set('authBaseURL', baseURL);
					// The test's minimal Better Auth instance is shaped narrower than
					// the production `Env` auth; the bearer path only reaches
					// `auth.api.getJwks()`, which it provides.
					c.set('auth', auth as unknown as Env['Variables']['auth']);
					await next();
				})
				.get('/protected', requireBearerUser, (c) => c.json(c.var.user))
				.get(
					'/keys-unreadable',
					async (c, next) => {
						c.set('auth', {
							api: {
								getJwks: async () => {
									throw new Error('jwks store unreachable');
								},
							},
						} as unknown as Env['Variables']['auth']);
						await next();
					},
					requireBearerUser,
					(c) => c.json(c.var.user),
				);

			return { auth, baseURL, db, server, wrongAudience, app };
		} catch (error) {
			if (isAddressInUse(error)) continue;
			throw error;
		}
	}

	throw new Error('Failed to find an available bearer-middleware test port.');
}

/**
 * Stub `c.var.db` shaped for the one Drizzle query the middleware makes.
 *
 * The middleware reads `db.query.user.findFirst({ where: eq(user.id, id) })`.
 * Tests issue exactly one user per setup, so the stub returns the lone row
 * (or null when the test mutates `db.user = []`). The `where` clause is
 * ignored, which is fine: a missing-user assertion only needs the empty
 * branch.
 */
function createFakeDb(memoryDb: MemoryDB) {
	return {
		query: {
			user: {
				findFirst: async () => memoryDb.user?.[0] ?? null,
			},
		},
	} as unknown as Env['Variables']['db'];
}
