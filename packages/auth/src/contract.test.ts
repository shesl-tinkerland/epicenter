/**
 * Auth Client Contract Tests
 *
 * Covers:
 * - PersistedAuth = { grant, localIdentity } shape
 * - AuthState three variants; profile data is absent from state
 * - Refresh writes only grant, localIdentity byte-identical
 * - Same-subject guard at /api/me response
 * - Network gate: bearer not attached until /api/me confirms same subject
 * - Cold-boot offline keeps signed-in with localIdentity and no profile field
 * - Legacy `{ grant, unlock: { userId, encryptionKeys } }` cells migrate
 *   transparently to `{ grant, localIdentity: { subject, keyring } }`
 */

import { BEARER_SUBPROTOCOL_PREFIX } from '@epicenter/constants/auth';
import type { SubjectKeyring } from '@epicenter/encryption';
import { describe, expect, test } from 'bun:test';
import { Ok } from 'wellcrafted/result';
import type {
	AuthClient,
	LocalWorkspaceIdentity,
	OAuthTokenGrant,
	PersistedAuth,
	PersistedAuthStorage,
} from './index.js';
import { createOAuthAppAuth, PersistedAuth as PersistedAuthSchema } from './index.js';

const now = 1_000_000;

const keyring: SubjectKeyring = [
	{
		version: 1,
		subjectKeyBase64: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=',
	},
];

function grant({
	accessToken = 'access-token',
	refreshToken = 'refresh-token',
	accessTokenExpiresAt = now + 3_600_000,
}: Partial<OAuthTokenGrant> = {}): OAuthTokenGrant {
	return { accessToken, refreshToken, accessTokenExpiresAt };
}

function cell({
	subject = 'user-1',
	grant: g = grant(),
}: {
	subject?: string;
	grant?: OAuthTokenGrant;
} = {}): PersistedAuth {
	return {
		grant: g,
		localIdentity: { subject, keyring: [...keyring] },
	};
}

function createStorage(initial: PersistedAuth | null = null) {
	let current = initial;
	const saved: Array<PersistedAuth | null> = [];
	const storage: PersistedAuthStorage = {
		get: () => current,
		set: async (next) => {
			current = next;
			saved.push(next);
		},
	};
	return {
		storage,
		saved,
		get current() {
			return current;
		},
	};
}

function json(value: unknown, init?: ResponseInit) {
	return new Response(JSON.stringify(value), {
		status: 200,
		...init,
		headers: { 'content-type': 'application/json', ...init?.headers },
	});
}

function oauthTokenResponse({
	accessToken = 'new-access',
	refreshToken = 'new-refresh',
	expiresIn = 3600,
}: {
	accessToken?: string;
	refreshToken?: string | null;
	expiresIn?: number;
} = {}) {
	const body: Record<string, unknown> = {
		access_token: accessToken,
		expires_in: expiresIn,
		token_type: 'bearer',
	};
	if (refreshToken !== null) body['refresh_token'] = refreshToken;
	return json(body);
}

function apiMeBody(subject = 'user-1') {
	return {
		user: { id: subject, email: `${subject}@example.com` },
		localIdentity: { subject, keyring: [...keyring] },
	};
}

function createWebSocketRecorder() {
	const openings: Array<{ url: string; protocols: string[] }> = [];
	const WebSocketRecorder = class {
		constructor(url: string | URL, protocols: string[] = []) {
			openings.push({ url: String(url), protocols });
		}
	} as unknown as typeof WebSocket;

	return { openings, WebSocketRecorder };
}

test('signed-out by default; AuthClient satisfies the public contract', () => {
	const setup = createStorage(null);
	const auth: AuthClient = createOAuthAppAuth({
		baseURL: 'http://localhost:8787',
		clientId: 'client-1',
		now: () => now,
		persistedAuthStorage: setup.storage,
		launcher: { startSignIn: async () => Ok(null) },
	});

	expect(auth.state).toEqual({ status: 'signed-out' });
	auth[Symbol.dispose]();
});

test('cold-boot signed-in exposes localIdentity immediately without profile data', () => {
	const setup = createStorage(cell());
	const auth = createOAuthAppAuth({
		baseURL: 'http://localhost:8787',
		clientId: 'client-1',
		now: () => now,
		persistedAuthStorage: setup.storage,
		launcher: { startSignIn: async () => Ok(null) },
	});

	expect(auth.state).toEqual({
		status: 'signed-in',
		localIdentity: { subject: 'user-1', keyring: [...keyring] },
	});
	expect('email' in auth.state).toBe(false);
	auth[Symbol.dispose]();
});

test('startSignIn calls /api/me and writes both sections', async () => {
	const setup = createStorage(null);
	const fetches: string[] = [];
	const auth = createOAuthAppAuth({
		baseURL: 'http://localhost:8787',
		clientId: 'client-1',
		now: () => now,
		persistedAuthStorage: setup.storage,
		launcher: {
			startSignIn: async () =>
				Ok({
					accessToken: 'sign-in-access',
					refreshToken: 'sign-in-refresh',
					accessTokenExpiresAt: now + 3_600_000,
				}),
		},
		fetch: async (input) => {
			fetches.push(String(input));
			return json(apiMeBody('user-1'));
		},
	});

	const result = await auth.startSignIn();
	expect(result).toEqual(Ok(undefined));
	expect(fetches[0]).toBe('http://localhost:8787/api/me');
	expect(setup.saved[0]).toEqual({
		grant: {
			accessToken: 'sign-in-access',
			refreshToken: 'sign-in-refresh',
			accessTokenExpiresAt: now + 3_600_000,
		},
		localIdentity: { subject: 'user-1', keyring: [...keyring] },
	});
	expect(auth.state).toMatchObject({
		status: 'signed-in',
	});
	expect('email' in auth.state).toBe(false);
	auth[Symbol.dispose]();
});

test('refresh writes ONLY the grant section; localIdentity byte-identical', async () => {
	const initial = cell({ grant: grant({ accessTokenExpiresAt: now + 1 }) });
	const setup = createStorage(initial);
	const auth = createOAuthAppAuth({
		baseURL: 'http://localhost:8787',
		clientId: 'client-1',
		now: () => now,
		persistedAuthStorage: setup.storage,
		launcher: { startSignIn: async () => Ok(null) },
		fetch: async (input) => {
			if (String(input).endsWith('/api/me')) return json(apiMeBody('user-1'));
			if (String(input).endsWith('/auth/oauth2/token')) {
				return oauthTokenResponse();
			}
			return new Response(null, { status: 204 });
		},
	});

	await auth.fetch('http://localhost:8787/resource');
	const last = setup.saved.at(-1);
	expect(last?.localIdentity).toEqual(initial.localIdentity);
	expect(last?.grant).toEqual({
		accessToken: 'new-access',
		refreshToken: 'new-refresh',
		accessTokenExpiresAt: now + 3_600_000,
	});
	auth[Symbol.dispose]();
});

test('refresh keeps existing refresh token when token response omits rotation', async () => {
	const initial = cell({ grant: grant({ accessTokenExpiresAt: now + 1 }) });
	const setup = createStorage(initial);
	const auth = createOAuthAppAuth({
		baseURL: 'http://localhost:8787',
		clientId: 'client-1',
		now: () => now,
		persistedAuthStorage: setup.storage,
		launcher: { startSignIn: async () => Ok(null) },
		fetch: async (input) => {
			if (String(input).endsWith('/api/me')) return json(apiMeBody('user-1'));
			if (String(input).endsWith('/auth/oauth2/token')) {
				return oauthTokenResponse({ refreshToken: null });
			}
			return new Response(null, { status: 204 });
		},
	});

	await auth.fetch('http://localhost:8787/resource');
	expect(setup.saved.at(-1)?.grant).toEqual({
		accessToken: 'new-access',
		refreshToken: 'refresh-token',
		accessTokenExpiresAt: now + 3_600_000,
	});
	auth[Symbol.dispose]();
});

test('same-subject guard wipes the cell when /api/me returns a different subject', async () => {
	const setup = createStorage(cell({ subject: 'alice' }));
	const auth = createOAuthAppAuth({
		baseURL: 'http://localhost:8787',
		clientId: 'client-1',
		now: () => now,
		persistedAuthStorage: setup.storage,
		launcher: { startSignIn: async () => Ok(null) },
		fetch: async (input) => {
			if (String(input).endsWith('/api/me')) return json(apiMeBody('bob'));
			return new Response(null, { status: 204 });
		},
	});

	const response = await auth.fetch('http://localhost:8787/resource');
	expect(response.status).toBe(204);
	expect(setup.current).toBeNull();
	expect(auth.state).toEqual({ status: 'signed-out' });
	auth[Symbol.dispose]();
});

test('same-subject /api/me preserves state when keyring is unchanged', async () => {
	const setup = createStorage(cell());
	const auth = createOAuthAppAuth({
		baseURL: 'http://localhost:8787',
		clientId: 'client-1',
		now: () => now,
		persistedAuthStorage: setup.storage,
		launcher: { startSignIn: async () => Ok(null) },
		fetch: async (input) => {
			if (String(input).endsWith('/api/me')) return json(apiMeBody('user-1'));
			return new Response(null, { status: 204 });
		},
	});

	await auth.fetch('http://localhost:8787/resource');
	expect(setup.current).toEqual(cell());
	// No localIdentity write should have happened: keyring unchanged.
	expect(setup.saved).toEqual([]);
	expect(auth.state).toMatchObject({ status: 'signed-in' });
	auth[Symbol.dispose]();
});

test('keyring rotation updates persisted localIdentity', async () => {
	const setup = createStorage(cell());
	const rotated: SubjectKeyring = [
		{
			version: 2,
			subjectKeyBase64: 'AQECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=',
		},
		...keyring,
	];
	const auth = createOAuthAppAuth({
		baseURL: 'http://localhost:8787',
		clientId: 'client-1',
		now: () => now,
		persistedAuthStorage: setup.storage,
		launcher: { startSignIn: async () => Ok(null) },
		fetch: async (input) => {
			if (String(input).endsWith('/api/me')) {
				return json({
					user: { id: 'user-1', email: 'user-1@example.com' },
					localIdentity: { subject: 'user-1', keyring: rotated },
				});
			}
			return new Response(null, { status: 204 });
		},
	});

	await auth.fetch('http://localhost:8787/resource');
	const last = setup.saved.at(-1);
	expect(last?.localIdentity).toEqual({ subject: 'user-1', keyring: rotated });
	expect(last?.grant).toEqual(cell().grant);
	expect(auth.state).toEqual({
		status: 'signed-in',
		localIdentity: { subject: 'user-1', keyring: rotated },
	});
	auth[Symbol.dispose]();
});

test('network gate: no Authorization header until /api/me confirms same subject', async () => {
	const setup = createStorage(cell());
	const seenAuth: Array<string | null> = [];
	let resolveApiMe!: (response: Response) => void;
	const apiMePromise = new Promise<Response>((r) => {
		resolveApiMe = r;
	});
	const auth = createOAuthAppAuth({
		baseURL: 'http://localhost:8787',
		clientId: 'client-1',
		now: () => now,
		persistedAuthStorage: setup.storage,
		launcher: { startSignIn: async () => Ok(null) },
		fetch: async (input, init) => {
			if (String(input).endsWith('/api/me')) return apiMePromise;
			seenAuth.push(new Headers(init?.headers).get('authorization'));
			return new Response(null, { status: 204 });
		},
	});

	const fetchPromise = auth.fetch('http://localhost:8787/resource');
	await Promise.resolve();
	expect(seenAuth).toEqual([]);
	resolveApiMe(json(apiMeBody('user-1')));
	await fetchPromise;
	expect(seenAuth).toEqual(['Bearer access-token']);
	auth[Symbol.dispose]();
});

test('auth.fetch resolves relative API paths against the auth base URL', async () => {
	const setup = createStorage(cell());
	const fetches: Array<{ url: string; authorization: string | null }> = [];
	const auth = createOAuthAppAuth({
		baseURL: 'http://localhost:8787',
		clientId: 'client-1',
		now: () => now,
		persistedAuthStorage: setup.storage,
		launcher: { startSignIn: async () => Ok(null) },
		fetch: async (input, init) => {
			fetches.push({
				url: String(input),
				authorization: new Headers(init?.headers).get('authorization'),
			});
			return json(apiMeBody('user-1'));
		},
	});

	const response = await auth.fetch('/api/me');
	expect(response.status).toBe(200);
	expect(fetches).toEqual([
		{
			url: 'http://localhost:8787/api/me',
			authorization: 'Bearer access-token',
		},
		{
			url: 'http://localhost:8787/api/me',
			authorization: 'Bearer access-token',
		},
	]);
	auth[Symbol.dispose]();
});

test('network gate: no WebSocket bearer protocol until /api/me confirms same subject', async () => {
	const setup = createStorage(cell());
	const { openings, WebSocketRecorder } = createWebSocketRecorder();
	let resolveApiMe!: (response: Response) => void;
	const apiMePromise = new Promise<Response>((r) => {
		resolveApiMe = r;
	});
	const auth = createOAuthAppAuth({
		baseURL: 'http://localhost:8787',
		clientId: 'client-1',
		now: () => now,
		persistedAuthStorage: setup.storage,
		launcher: { startSignIn: async () => Ok(null) },
		WebSocket: WebSocketRecorder,
		fetch: async (input) => {
			if (String(input).endsWith('/api/me')) return apiMePromise;
			return new Response(null, { status: 204 });
		},
	});

	const socketPromise = auth.openWebSocket('ws://localhost:8787/sync', [
		'epicenter.v1',
	]);
	await Promise.resolve();
	expect(openings).toEqual([]);
	resolveApiMe(json(apiMeBody('user-1')));
	await socketPromise;
	expect(openings).toEqual([
		{
			url: 'ws://localhost:8787/sync',
			protocols: [
				'epicenter.v1',
				`${BEARER_SUBPROTOCOL_PREFIX}access-token`,
			],
		},
	]);
	auth[Symbol.dispose]();
});

test('cold-boot offline keeps signed-in with localIdentity and no profile field', async () => {
	const setup = createStorage(cell());
	const auth = createOAuthAppAuth({
		baseURL: 'http://localhost:8787',
		clientId: 'client-1',
		now: () => now,
		persistedAuthStorage: setup.storage,
		launcher: { startSignIn: async () => Ok(null) },
		fetch: async () => {
			throw new Error('offline');
		},
	});

	expect(auth.state).toMatchObject({
		status: 'signed-in',
	});
	expect('email' in auth.state).toBe(false);
	expect(
		(auth.state as { localIdentity: LocalWorkspaceIdentity }).localIdentity,
	).toEqual({
		subject: 'user-1',
		keyring: [...keyring],
	});
	auth[Symbol.dispose]();
});

test('signOut clears cell and network pause even when revoke fails', async () => {
	const setup = createStorage(cell());
	const originalConsoleError = console.error;
	console.error = () => undefined;
	let markRevokeStarted!: () => void;
	let resolveRevoke!: () => void;
	const revokeStarted = new Promise<void>((r) => {
		markRevokeStarted = r;
	});
	const revokePromise = new Promise<void>((resolve) => {
		resolveRevoke = resolve;
	});
	const auth = createOAuthAppAuth({
		baseURL: 'http://localhost:8787',
		clientId: 'client-1',
		now: () => now,
		persistedAuthStorage: setup.storage,
		launcher: { startSignIn: async () => Ok(null) },
		fetch: async (input, init) => {
			if (String(input).endsWith('/api/me')) return json(apiMeBody('user-1'));
			if (String(input).endsWith('/auth/oauth2/token')) {
				return new Response(null, { status: 503 });
			}
			if (String(input).endsWith('/auth/oauth2/revoke')) {
				const body = new URLSearchParams(String(init?.body ?? ''));
				expect(body.get('token')).toBe('refresh-token');
				markRevokeStarted();
				await revokePromise;
				return new Response(null, { status: 503 });
			}
			return new Response(null, { status: 401 });
		},
	});

	try {
		await auth.fetch('http://localhost:8787/resource');
		expect(auth.state).toEqual({
			status: 'reauth-required',
			localIdentity: { subject: 'user-1', keyring: [...keyring] },
		});
		expect('email' in auth.state).toBe(false);

		const signOutPromise = auth.signOut();
		await Promise.resolve();
		expect(setup.current).toBeNull();
		expect(auth.state).toEqual({ status: 'signed-out' });
		expect(await signOutPromise).toEqual(Ok(undefined));
		await revokeStarted;
		resolveRevoke();
		await Promise.resolve();
	} finally {
		console.error = originalConsoleError;
		auth[Symbol.dispose]();
	}
});

test('network verification clears on grant refresh until /api/me confirms new cell', async () => {
	const setup = createStorage(cell());
	const resourceAuths: Array<string | null> = [];
	const apiMeAuths: Array<string | null> = [];
	let apiMeCalls = 0;
	let resolveSecondApiMe!: (response: Response) => void;
	let markSecondApiMeRequested!: () => void;
	const secondApiMePromise = new Promise<Response>((r) => {
		resolveSecondApiMe = r;
	});
	const secondApiMeRequested = new Promise<void>((r) => {
		markSecondApiMeRequested = r;
	});
	const auth = createOAuthAppAuth({
		baseURL: 'http://localhost:8787',
		clientId: 'client-1',
		now: () => now,
		persistedAuthStorage: setup.storage,
		launcher: { startSignIn: async () => Ok(null) },
		fetch: async (input, init) => {
			const authorization = new Headers(init?.headers).get('authorization');
			if (String(input).endsWith('/api/me')) {
				apiMeCalls += 1;
				apiMeAuths.push(authorization);
				if (apiMeCalls === 1) return json(apiMeBody('user-1'));
				markSecondApiMeRequested();
				return secondApiMePromise;
			}
			if (String(input).endsWith('/auth/oauth2/token')) {
				return oauthTokenResponse();
			}
			resourceAuths.push(authorization);
			if (resourceAuths.length === 2)
				return new Response(null, { status: 401 });
			return new Response(null, { status: 204 });
		},
	});

	await auth.fetch('http://localhost:8787/resource');
	expect(auth.state).toMatchObject({ status: 'signed-in' });
	expect('email' in auth.state).toBe(false);

	const retryPromise = auth.fetch('http://localhost:8787/resource');
	await secondApiMeRequested;
	expect(auth.state).toEqual({
		status: 'signed-in',
		localIdentity: { subject: 'user-1', keyring: [...keyring] },
	});
	expect('email' in auth.state).toBe(false);
	expect(resourceAuths).toEqual(['Bearer access-token', 'Bearer access-token']);
	expect(apiMeAuths).toEqual(['Bearer access-token', 'Bearer new-access']);

	resolveSecondApiMe(json(apiMeBody('user-1')));
	await retryPromise;
	expect(auth.state).toMatchObject({ status: 'signed-in' });
	expect('email' in auth.state).toBe(false);
	expect(resourceAuths).toEqual([
		'Bearer access-token',
		'Bearer access-token',
		'Bearer new-access',
	]);
	auth[Symbol.dispose]();
});

test('concurrent refresh shares one promise and signOut during refresh wins', async () => {
	const setup = createStorage(
		cell({ grant: grant({ accessTokenExpiresAt: now + 1 }) }),
	);
	const resourceAuths: Array<string | null> = [];
	let refreshCalls = 0;
	let markRefreshStarted!: () => void;
	let resolveRefresh!: (response: Response) => void;
	const refreshStarted = new Promise<void>((r) => {
		markRefreshStarted = r;
	});
	const refreshPromise = new Promise<Response>((r) => {
		resolveRefresh = r;
	});
	const auth = createOAuthAppAuth({
		baseURL: 'http://localhost:8787',
		clientId: 'client-1',
		now: () => now,
		persistedAuthStorage: setup.storage,
		launcher: { startSignIn: async () => Ok(null) },
		fetch: async (input, init) => {
			if (String(input).endsWith('/auth/oauth2/token')) {
				refreshCalls += 1;
				markRefreshStarted();
				return refreshPromise;
			}
			if (String(input).endsWith('/auth/oauth2/revoke')) {
				const body = new URLSearchParams(String(init?.body ?? ''));
				expect(body.get('token')).toBe('refresh-token');
				return new Response(null, { status: 200 });
			}
			resourceAuths.push(new Headers(init?.headers).get('authorization'));
			return new Response(null, { status: 204 });
		},
	});

	const firstFetch = auth.fetch('http://localhost:8787/first');
	const secondFetch = auth.fetch('http://localhost:8787/second');
	await refreshStarted;
	expect(refreshCalls).toBe(1);
	expect(resourceAuths).toEqual([]);

	const signOutResult = await auth.signOut();
	expect(signOutResult).toEqual(Ok(undefined));
	expect(setup.current).toBeNull();
	expect(auth.state).toEqual({ status: 'signed-out' });

	resolveRefresh(oauthTokenResponse());
	await Promise.all([firstFetch, secondFetch]);
	expect(setup.current).toBeNull();
	expect(resourceAuths).toEqual([null, null]);
	expect(auth.state).toEqual({ status: 'signed-out' });
	auth[Symbol.dispose]();
});

test('/api/me response after signOut is discarded without corrupting state', async () => {
	const setup = createStorage(cell());
	const resourceAuths: Array<string | null> = [];
	let resolveApiMe!: (response: Response) => void;
	const apiMePromise = new Promise<Response>((r) => {
		resolveApiMe = r;
	});
	const auth = createOAuthAppAuth({
		baseURL: 'http://localhost:8787',
		clientId: 'client-1',
		now: () => now,
		persistedAuthStorage: setup.storage,
		launcher: { startSignIn: async () => Ok(null) },
		fetch: async (input, init) => {
			if (String(input).endsWith('/api/me')) return apiMePromise;
			if (String(input).endsWith('/auth/oauth2/revoke')) {
				const body = new URLSearchParams(String(init?.body ?? ''));
				expect(body.get('token')).toBe('refresh-token');
				return new Response(null, { status: 200 });
			}
			resourceAuths.push(new Headers(init?.headers).get('authorization'));
			return new Response(null, { status: 204 });
		},
	});

	const fetchPromise = auth.fetch('http://localhost:8787/resource');
	await Promise.resolve();
	const signOutResult = await auth.signOut();
	expect(signOutResult).toEqual(Ok(undefined));
	expect(setup.current).toBeNull();
	expect(auth.state).toEqual({ status: 'signed-out' });

	resolveApiMe(json(apiMeBody('user-1')));
	await fetchPromise;
	expect(setup.current).toBeNull();
	expect(auth.state).toEqual({ status: 'signed-out' });
	expect(resourceAuths).toEqual([null]);
	auth[Symbol.dispose]();
});

test('/api/me key update after signOut is discarded without writing localIdentity', async () => {
	const setup = createStorage(cell());
	const rotated: SubjectKeyring = [
		{
			version: 2,
			subjectKeyBase64: 'AQECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=',
		},
	];
	let resolveApiMe!: (response: Response) => void;
	const apiMePromise = new Promise<Response>((r) => {
		resolveApiMe = r;
	});
	const auth = createOAuthAppAuth({
		baseURL: 'http://localhost:8787',
		clientId: 'client-1',
		now: () => now,
		persistedAuthStorage: setup.storage,
		launcher: { startSignIn: async () => Ok(null) },
		fetch: async (input, init) => {
			if (String(input).endsWith('/api/me')) return apiMePromise;
			if (String(input).endsWith('/auth/oauth2/revoke')) {
				const body = new URLSearchParams(String(init?.body ?? ''));
				expect(body.get('token')).toBe('refresh-token');
				return new Response(null, { status: 200 });
			}
			return new Response(null, { status: 204 });
		},
	});

	const fetchPromise = auth.fetch('http://localhost:8787/resource');
	await Promise.resolve();
	const signOutResult = await auth.signOut();
	expect(signOutResult).toEqual(Ok(undefined));

	resolveApiMe(
		json({
			user: { id: 'user-1', email: 'user-1@example.com' },
			localIdentity: { subject: 'user-1', keyring: rotated },
		}),
	);
	await fetchPromise;
	expect(setup.current).toBeNull();
	expect(setup.saved).not.toContainEqual({
		grant: grant(),
		localIdentity: { subject: 'user-1', keyring: rotated },
	});
	expect(auth.state).toEqual({ status: 'signed-out' });
	auth[Symbol.dispose]();
});

describe('legacy persisted shape', () => {
	const legacyValue = {
		grant: grant(),
		unlock: {
			userId: 'user-1',
			encryptionKeys: [
				{
					version: 1,
					subjectKeyBase64: keyring[0]!.subjectKeyBase64,
				},
			],
		},
	};

	test('PersistedAuth schema accepts and migrates the old shape', () => {
		const parsed = PersistedAuthSchema.assert(legacyValue);
		expect(parsed).toEqual({
			grant: grant(),
			localIdentity: { subject: 'user-1', keyring: [...keyring] },
		});
		// Validating the migrated value again is idempotent.
		expect(PersistedAuthSchema.assert(parsed)).toEqual(parsed);
	});

	test('browser localStorage style storage migrates legacy bytes on first read', () => {
		// Simulate createPersistedState reading a legacy blob: the schema runs
		// on the raw parsed JSON and produces the new shape.
		const raw = JSON.stringify(legacyValue);
		const migrated = PersistedAuthSchema.assert(JSON.parse(raw));
		expect(migrated).toEqual({
			grant: grant(),
			localIdentity: { subject: 'user-1', keyring: [...keyring] },
		});
	});

	test('chrome.storage.local style storage migrates legacy object on first read', () => {
		// chrome.storage hands back an object instead of a string; same path.
		const migrated = PersistedAuthSchema.assert(legacyValue);
		expect(migrated).toEqual({
			grant: grant(),
			localIdentity: { subject: 'user-1', keyring: [...keyring] },
		});
	});

	test('createOAuthAppAuth normalizes legacy cells in memory', async () => {
		const setup = createStorage(
			PersistedAuthSchema.assert(legacyValue) as PersistedAuth,
		);
		const auth = createOAuthAppAuth({
			baseURL: 'http://localhost:8787',
			clientId: 'client-1',
			now: () => now,
			persistedAuthStorage: setup.storage,
			launcher: { startSignIn: async () => Ok(null) },
			fetch: async () => json(apiMeBody('user-1')),
		});

		expect(auth.state).toEqual({
			status: 'signed-in',
			localIdentity: { subject: 'user-1', keyring: [...keyring] },
		});
		auth[Symbol.dispose]();
	});
});

describe('removed legacy surface', () => {
	test('requireIdentity / requireSession / OAuthSession are not exported', async () => {
		const mod = await import('./index.js');
		// @ts-expect-error: requireIdentity removed; reach for state.localIdentity.
		expect(mod.requireIdentity).toBeUndefined();
		// @ts-expect-error: requireSession removed.
		expect(mod.requireSession).toBeUndefined();
		// @ts-expect-error: OAuthSession deleted; use PersistedAuth.
		expect(mod.OAuthSession).toBeUndefined();
		// @ts-expect-error: LocalUnlockBundle replaced by LocalWorkspaceIdentity.
		expect(mod.LocalUnlockBundle).toBeUndefined();
	});
});
