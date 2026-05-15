/**
 * Protected Resource Boundary Tests
 *
 * Covers the three exported helpers in `resource-boundary.ts`:
 *
 * - `parseBearer`: header parsing used by both the well-formedness layer
 *   (`single-credential`) and the resolvers below.
 * - `resolveBearerUser`: cheap resolver used by `requireOAuthUser` for every
 *   protected app resource (`/ai/*`, `/rooms/*`,
 *   `/api/billing/*`, `/api/assets/*`).
 * - `resolveBearerIdentity`: full resolver used by `/api/me`, adding the
 *   derived local workspace identity (subject + per-subject keyring) to the
 *   returned payload.
 *
 * HTTP and WebSocket wire-format coverage lives in `oauth-resource.test.ts`.
 */

import { expect, test } from 'bun:test';
import { oauthProvider } from '@better-auth/oauth-provider';
import { oauthProviderResourceClient } from '@better-auth/oauth-provider/resource-client';
import type { SubjectKeyring } from '@epicenter/encryption';
import { betterAuth } from 'better-auth';
import { memoryAdapter } from 'better-auth/adapters/memory';
import { jwt } from 'better-auth/plugins';
import {
	createOAuthTestDb,
	isAddressInUse,
	issueOAuthTokens,
} from '../test-helpers/oauth.js';
import {
	parseBearer,
	resolveBearerIdentity,
	resolveBearerUser,
} from './resource-boundary.js';

const keyring: SubjectKeyring = [
	{
		version: 1,
		subjectKeyBase64: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=',
	},
];
let nextBoundaryTestPort = 51_000 + Math.floor(Math.random() * 10_000);

// ---------------------------------------------------------------------------
// parseBearer
// ---------------------------------------------------------------------------

test('parseBearer extracts the token from a Bearer header', () => {
	expect(parseBearer('Bearer abc.def.ghi')).toBe('abc.def.ghi');
});

test('parseBearer is case-insensitive on the scheme and trims whitespace', () => {
	expect(parseBearer('bearer   abc.def.ghi   ')).toBe('abc.def.ghi');
	expect(parseBearer('BEARER abc.def.ghi')).toBe('abc.def.ghi');
});

test('parseBearer returns null for missing, empty, or non-bearer input', () => {
	expect(parseBearer(null)).toBeNull();
	expect(parseBearer('')).toBeNull();
	expect(parseBearer('Bearer ')).toBeNull();
	expect(parseBearer('Token abc')).toBeNull();
});

// ---------------------------------------------------------------------------
// resolveBearerUser
// ---------------------------------------------------------------------------

test('resolveBearerUser resolves a valid scoped token to the calling user', async () => {
	const setup = createBoundaryTestServer();
	try {
		const { accessToken } = await issueOAuthTokens(setup, {
			clientName: 'Resource Boundary Test',
			email: 'boundary-test@example.com',
			name: 'Boundary Test',
		});
		const { data, error } = await callUser(setup, accessToken);

		expect(error).toBeNull();
		expect(data).toEqual({
			id: expect.any(String),
			email: 'boundary-test@example.com',
		});
	} finally {
		setup.server.stop(true);
	}
});

test('resolveBearerUser rejects tokens missing the workspaces:open scope', async () => {
	const setup = createBoundaryTestServer();
	try {
		const { accessToken } = await issueOAuthTokens(setup, {
			clientName: 'Resource Boundary Test',
			email: 'boundary-test@example.com',
			name: 'Boundary Test',
			scope: 'openid profile email offline_access',
		});
		const { data, error } = await callUser(setup, accessToken);

		expect(data).toBeNull();
		expect(error?.name).toBe('InsufficientScope');
		expect(error?.name === 'InsufficientScope' && error.scope).toBe(
			'workspaces:open',
		);
	} finally {
		setup.server.stop(true);
	}
});

test('resolveBearerUser rejects tokens issued for the wrong audience as InvalidToken', async () => {
	const setup = createBoundaryTestServer();
	try {
		const { accessToken } = await issueOAuthTokens(setup, {
			clientName: 'Resource Boundary Test',
			email: 'boundary-test@example.com',
			name: 'Boundary Test',
			resource: setup.wrongAudience,
		});
		const { data, error } = await callUser(setup, accessToken);

		expect(data).toBeNull();
		expect(error?.name).toBe('InvalidToken');
	} finally {
		setup.server.stop(true);
	}
});

test('resolveBearerUser rejects tokens verified against the wrong issuer as InvalidToken', async () => {
	const setup = createBoundaryTestServer();
	try {
		const { accessToken } = await issueOAuthTokens(setup, {
			clientName: 'Resource Boundary Test',
			email: 'boundary-test@example.com',
			name: 'Boundary Test',
		});
		const { data, error } = await callUser(setup, accessToken, {
			issuer: `${setup.baseURL}/some-other-issuer`,
		});

		expect(data).toBeNull();
		expect(error?.name).toBe('InvalidToken');
	} finally {
		setup.server.stop(true);
	}
});

test('resolveBearerUser rejects malformed bearer input before calling the verifier', async () => {
	let verifierCalls = 0;
	const { data, error } = await resolveBearerUser({
		authorization: 'Token not-a-bearer',
		audience: 'http://localhost:8787',
		issuer: 'http://localhost:8787/auth',
		jwksUrl: 'http://localhost:8787/auth/jwks',
		verifyOAuthAccessToken: async () => {
			verifierCalls += 1;
			return null as never;
		},
		findUserById: async () => {
			throw new Error('findUserById should not run');
		},
	});

	expect(data).toBeNull();
	expect(error?.name).toBe('InvalidToken');
	expect(verifierCalls).toBe(0);
});

test('resolveBearerUser rejects tokens whose user no longer exists as InvalidToken', async () => {
	const setup = createBoundaryTestServer();
	try {
		const { accessToken } = await issueOAuthTokens(setup, {
			clientName: 'Resource Boundary Test',
			email: 'boundary-test@example.com',
			name: 'Boundary Test',
		});
		setup.db.user = [];

		const { data, error } = await callUser(setup, accessToken);

		expect(data).toBeNull();
		expect(error?.name).toBe('InvalidToken');
	} finally {
		setup.server.stop(true);
	}
});

// ---------------------------------------------------------------------------
// resolveBearerIdentity
// ---------------------------------------------------------------------------

test('resolveBearerIdentity returns user + local workspace identity for a valid token', async () => {
	const setup = createBoundaryTestServer();
	try {
		const { accessToken } = await issueOAuthTokens(setup, {
			clientName: 'Resource Boundary Test',
			email: 'boundary-test@example.com',
			name: 'Boundary Test',
		});
		const { data, error } = await callIdentity(setup, accessToken);

		expect(error).toBeNull();
		expect(data?.user.email).toBe('boundary-test@example.com');
		expect(data?.localIdentity.subject).toBe(data?.user.id);
		expect(data?.localIdentity.keyring).toEqual(keyring);
	} finally {
		setup.server.stop(true);
	}
});

test('resolveBearerIdentity short-circuits findUserById and key derivation on verifier failure', async () => {
	const { data, error } = await resolveBearerIdentity({
		authorization: 'Bearer expired-token',
		audience: 'http://localhost:8787',
		issuer: 'http://localhost:8787/auth',
		jwksUrl: 'http://localhost:8787/auth/jwks',
		verifyOAuthAccessToken: async () => {
			throw new Error('JWTExpired');
		},
		findUserById: async () => {
			throw new Error('findUserById should not run');
		},
		deriveSubjectKeyring: async () => {
			throw new Error('deriveSubjectKeyring should not run');
		},
	});

	expect(data).toBeNull();
	expect(error?.name).toBe('InvalidToken');
});

// ---------------------------------------------------------------------------
// Shared test plumbing
// ---------------------------------------------------------------------------

function createBoundaryTestServer() {
	const db = createOAuthTestDb();

	for (let attempt = 0; attempt < 40; attempt += 1) {
		const port = nextBoundaryTestPort++;
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
					scopes: [
						'openid',
						'profile',
						'email',
						'offline_access',
						'workspaces:open',
					],
					silenceWarnings: { oauthAuthServerConfig: true, openidConfig: true },
				}),
			],
		});

		try {
			const server = Bun.serve({
				port,
				fetch: async (request) => auth.handler(request),
			});

			return { auth, baseURL, db, server, wrongAudience };
		} catch (error) {
			if (isAddressInUse(error)) continue;
			throw error;
		}
	}

	throw new Error('Failed to find an available resource-boundary test port.');
}

function commonResolverDeps(
	setup: ReturnType<typeof createBoundaryTestServer>,
	accessToken: string,
	overrides: { audience?: string; issuer?: string } = {},
) {
	const resource = oauthProviderResourceClient();
	return {
		authorization: `Bearer ${accessToken}`,
		audience: overrides.audience ?? setup.baseURL,
		issuer: overrides.issuer ?? `${setup.baseURL}/auth`,
		jwksUrl: `${setup.baseURL}/auth/jwks`,
		verifyOAuthAccessToken: resource.getActions().verifyAccessToken,
		findUserById: async (userId: string) =>
			setup.db.user?.find((user) => user.id === userId) ?? null,
	};
}

async function callUser(
	setup: ReturnType<typeof createBoundaryTestServer>,
	accessToken: string,
	overrides: { audience?: string; issuer?: string } = {},
) {
	return resolveBearerUser(commonResolverDeps(setup, accessToken, overrides));
}

async function callIdentity(
	setup: ReturnType<typeof createBoundaryTestServer>,
	accessToken: string,
	overrides: { audience?: string; issuer?: string } = {},
) {
	return resolveBearerIdentity({
		...commonResolverDeps(setup, accessToken, overrides),
		deriveSubjectKeyring: async () => keyring,
	});
}
