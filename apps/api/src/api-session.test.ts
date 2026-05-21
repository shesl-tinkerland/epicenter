/**
 * GET /api/session integration tests.
 *
 * The session projection endpoint is the single Epicenter session surface
 * clients fetch at sign-in and at cold-boot when online. It returns
 * { user: AuthUser, localIdentity: LocalIdentity }; unauthenticated
 * bearer callers get RFC 6750-shaped errors via
 * createOAuthUnauthorizedResourceResponse.
 *
 * Built on a minimal memory-adapter Better Auth instance plus the pure bearer
 * user resolver behind the Hono adapter wired in `app.ts`.
 */

import { expect, test } from 'bun:test';
import { oauthProvider } from '@better-auth/oauth-provider';
import { oauthProviderResourceClient } from '@better-auth/oauth-provider/resource-client';
import { EPICENTER_OAUTH_SCOPES } from '@epicenter/constants/oauth';
import type { SubjectKeyring } from '@epicenter/encryption';
import { betterAuth } from 'better-auth';
import { memoryAdapter } from 'better-auth/adapters/memory';
import { jwt } from 'better-auth/plugins';
import { Hono } from 'hono';
import { createOAuthUnauthorizedResourceResponse } from './auth/oauth-resource.js';
import { resolveBearerUser } from './auth/resource-boundary.js';
import {
	createOAuthTestDb,
	isAddressInUse,
	issueOAuthTokens,
	randomOAuthTestPort,
} from './test-helpers/oauth.js';

const keyring: SubjectKeyring = [
	{
		version: 1,
		subjectKeyBase64: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=',
	},
];

test('GET /api/session returns user + local workspace identity for a valid bearer', async () => {
	const setup = createApiSessionTestServer();
	try {
		const { accessToken } = await issueOAuthTokens(setup, {
			clientName: 'Api Session Test Client',
			email: 'api-session-test@example.com',
			name: 'Api Session Test',
		});
		const response = await setup.app.request('/api/session', {
			headers: { authorization: `Bearer ${accessToken}` },
		});

		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			user: { id: string; email: string };
			localIdentity: { subject: string; keyring: SubjectKeyring };
		};
		expect(body.user.email).toBe('api-session-test@example.com');
		expect(typeof body.user.id).toBe('string');
		expect(body.localIdentity.subject).toBe(body.user.id);
		expect(body.localIdentity.keyring).toEqual(keyring);
	} finally {
		setup.server.stop(true);
	}
});

test('GET /api/session returns 401 without a bearer', async () => {
	const setup = createApiSessionTestServer();
	try {
		const response = await setup.app.request('/api/session');

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

test('GET /api/session accepts a valid API-audience token without a custom resource scope', async () => {
	const setup = createApiSessionTestServer();
	try {
		const { accessToken } = await issueOAuthTokens(setup, {
			clientName: 'Api Session Test Client',
			email: 'api-session-test@example.com',
			name: 'Api Session Test',
			scope: 'openid profile email offline_access',
		});
		const response = await setup.app.request('/api/session', {
			headers: { authorization: `Bearer ${accessToken}` },
		});

		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			user: { id: string; email: string };
			localIdentity: { subject: string; keyring: SubjectKeyring };
		};
		expect(body.user.email).toBe('api-session-test@example.com');
		expect(body.localIdentity.subject).toBe(body.user.id);
		expect(body.localIdentity.keyring).toEqual(keyring);
	} finally {
		setup.server.stop(true);
	}
});

test('GET /api/session returns 401 for a malformed bearer', async () => {
	const setup = createApiSessionTestServer();
	try {
		const response = await setup.app.request('/api/session', {
			headers: { authorization: 'Token not-a-bearer' },
		});

		expect(response.status).toBe(401);
	} finally {
		setup.server.stop(true);
	}
});

// ---------------------------------------------------------------------------
// Test plumbing
// ---------------------------------------------------------------------------

function createApiSessionTestServer() {
	const db = createOAuthTestDb();

	for (let attempt = 0; attempt < 200; attempt += 1) {
		const port = randomOAuthTestPort();
		const baseURL = `http://localhost:${port}`;
		const auth = betterAuth({
			database: memoryAdapter(db),
			emailAndPassword: { enabled: true },
			basePath: '/auth',
			baseURL,
			secret: 'test-secret-test-secret-test-secret',
			plugins: [
				jwt({ jwks: { keyPairConfig: { alg: 'ES256' } } }),
				oauthProvider({
					loginPage: '/sign-in',
					consentPage: '/consent',
					requirePKCE: true,
					validAudiences: [baseURL],
					allowDynamicClientRegistration: false,
					scopes: [...EPICENTER_OAUTH_SCOPES],
					silenceWarnings: {
						oauthAuthServerConfig: true,
						openidConfig: true,
					},
				}),
			],
		});

		try {
			const server = Bun.serve({
				port,
				fetch: async (request) => auth.handler(request),
			});

			const resource = oauthProviderResourceClient();
			const app = new Hono();
			app.get('/api/session', async (c) => {
				const { data: user, error } = await resolveBearerUser({
					authorization: c.req.header('authorization') ?? null,
					audience: baseURL,
					issuer: `${baseURL}/auth`,
					jwksUrl: `${baseURL}/auth/jwks`,
					verifyOAuthAccessToken: resource.getActions().verifyAccessToken,
					findUserById: async (userId) =>
						db.user?.find((u) => u.id === userId) ?? null,
				});
				if (error) return createOAuthUnauthorizedResourceResponse(c, error);
				return c.json({
					user,
					localIdentity: {
						subject: user.id,
						keyring,
					},
				});
			});

			return { auth, baseURL, db, server, app };
		} catch (error) {
			if (isAddressInUse(error)) continue;
			throw error;
		}
	}

	throw new Error('Failed to find an available /api/session test port.');
}
