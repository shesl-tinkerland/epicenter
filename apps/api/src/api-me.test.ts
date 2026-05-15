/**
 * GET /api/me integration tests.
 *
 * The current-user endpoint is the single Epicenter identity surface
 * clients fetch at sign-in and at cold-boot when online. It returns
 * { user: AuthUser, localIdentity: LocalWorkspaceIdentity }; unauthenticated
 * or under-scoped callers get RFC 6750-shaped errors via
 * createOAuthUnauthorizedResourceResponse.
 *
 * Built on a minimal memory-adapter Better Auth instance plus the pure bearer
 * identity resolver behind the Hono adapter wired in `app.ts`.
 */

import { expect, test } from 'bun:test';
import { oauthProvider } from '@better-auth/oauth-provider';
import { oauthProviderResourceClient } from '@better-auth/oauth-provider/resource-client';
import type { SubjectKeyring } from '@epicenter/encryption';
import { betterAuth } from 'better-auth';
import { memoryAdapter } from 'better-auth/adapters/memory';
import { jwt } from 'better-auth/plugins';
import { Hono } from 'hono';
import { createOAuthUnauthorizedResourceResponse } from './auth/oauth-resource.js';
import { resolveBearerIdentity } from './auth/resource-boundary.js';
import {
	createOAuthTestDb,
	isAddressInUse,
	issueOAuthTokens,
} from './test-helpers/oauth.js';

const keyring: SubjectKeyring = [
	{
		version: 1,
		subjectKeyBase64: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=',
	},
];
let nextApiMeTestPort = 47_000 + Math.floor(Math.random() * 4_000);

test('GET /api/me returns user + local workspace identity for a valid scoped bearer', async () => {
	const setup = createApiMeTestServer();
	try {
		const { accessToken } = await issueOAuthTokens(setup, {
			clientName: 'Api Me Test Client',
			email: 'api-me-test@example.com',
			name: 'Api Me Test',
		});
		const response = await setup.app.request('/api/me', {
			headers: { authorization: `Bearer ${accessToken}` },
		});

		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			user: { id: string; email: string };
			localIdentity: { subject: string; keyring: SubjectKeyring };
		};
		expect(body.user.email).toBe('api-me-test@example.com');
		expect(typeof body.user.id).toBe('string');
		expect(body.localIdentity.subject).toBe(body.user.id);
		expect(body.localIdentity.keyring).toEqual(keyring);
	} finally {
		setup.server.stop(true);
	}
});

test('GET /api/me returns 401 without a bearer', async () => {
	const setup = createApiMeTestServer();
	try {
		const response = await setup.app.request('/api/me');

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

test('GET /api/me returns 403 when the token lacks workspaces:open scope', async () => {
	const setup = createApiMeTestServer();
	try {
		const { accessToken } = await issueOAuthTokens(setup, {
			clientName: 'Api Me Test Client',
			email: 'api-me-test@example.com',
			name: 'Api Me Test',
			scope: 'openid profile email offline_access',
		});
		const response = await setup.app.request('/api/me', {
			headers: { authorization: `Bearer ${accessToken}` },
		});

		expect(response.status).toBe(403);
		expect(response.headers.get('WWW-Authenticate')).toBe(
			'Bearer error="insufficient_scope" scope="workspaces:open"',
		);
		const body = (await response.json()) as { name: string; scope: string };
		expect(body.name).toBe('InsufficientScope');
		expect(body.scope).toBe('workspaces:open');
	} finally {
		setup.server.stop(true);
	}
});

test('GET /api/me returns 401 for a malformed bearer', async () => {
	const setup = createApiMeTestServer();
	try {
		const response = await setup.app.request('/api/me', {
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

function createApiMeTestServer() {
	const db = createOAuthTestDb();

	for (let attempt = 0; attempt < 40; attempt += 1) {
		const port = nextApiMeTestPort++;
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
					scopes: [
						'openid',
						'profile',
						'email',
						'offline_access',
						'workspaces:open',
					],
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
			app.get('/api/me', async (c) => {
				const { data: identity, error } = await resolveBearerIdentity({
					authorization: c.req.header('authorization') ?? null,
					audience: baseURL,
					issuer: `${baseURL}/auth`,
					jwksUrl: `${baseURL}/auth/jwks`,
					verifyOAuthAccessToken: resource.getActions().verifyAccessToken,
					findUserById: async (userId) =>
						db.user?.find((u) => u.id === userId) ?? null,
					deriveSubjectKeyring: async () => keyring,
				});
				if (error) return createOAuthUnauthorizedResourceResponse(c, error);
				return c.json(identity);
			});

			return { auth, baseURL, db, server, app };
		} catch (error) {
			if (isAddressInUse(error)) continue;
			throw error;
		}
	}

	throw new Error('Failed to find an available /api/me test port.');
}
