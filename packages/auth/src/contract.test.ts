/**
 * Auth Client Contract Tests
 *
 * Pins the auth core side of the OAuth split. Launchers may return a token
 * grant, but only auth core can verify `/api/session`, persist identity, refresh
 * the grant, and attach bearer credentials to fetch or WebSocket transports.
 *
 * Covers:
 * - PersistedAuth = { grant, userId, ownerId, keyring } shape
 * - AuthState three variants; profile data is absent from state
 * - Refresh writes only grant, identity + keyring byte-identical
 * - Same-owner guard at /api/session response
 * - Network gate: bearer not attached until /api/session confirms same owner
 * - Cold-boot offline keeps signed-in with ownerId + keyring and no profile field
 */

import { expect, test } from 'bun:test';
import { BEARER_SUBPROTOCOL_PREFIX } from '@epicenter/constants/auth';
import { asOwnerId } from '@epicenter/constants/identity';
import type { Keyring } from '@epicenter/encryption';
import { Ok, type Result } from 'wellcrafted/result';
import type {
	AuthClient,
	OAuthTokenGrant,
	PersistedAuth,
	PersistedAuthStorage,
} from './index.js';
import { asUserId, createOAuthAppAuth } from './index.js';
import type { OAuthLaunchResult } from './oauth-launchers/contract.js';

const now = 1_000_000;

const keyring: Keyring = [
	{
		version: 1,
		keyBytesBase64: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=',
	},
];

function grant({
	accessToken = 'access-token',
	refreshToken = 'refresh-token',
	accessTokenExpiresAt = now + 3_600_000,
}: Partial<OAuthTokenGrant> = {}): OAuthTokenGrant {
	return { accessToken, refreshToken, accessTokenExpiresAt };
}

function launched() {
	return Ok({ status: 'launched' } satisfies OAuthLaunchResult);
}

function completed(g: OAuthTokenGrant) {
	return Ok({ status: 'completed', grant: g } satisfies OAuthLaunchResult);
}

function cell({
	userId = 'user-1',
	grant: g = grant(),
}: {
	userId?: string;
	grant?: OAuthTokenGrant;
} = {}): PersistedAuth {
	return {
		grant: g,
		userId: asUserId(userId),
		ownerId: asOwnerId(userId),
		keyring: [...keyring],
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

function apiSessionBody(userId = 'user-1') {
	return {
		user: { id: userId, email: `${userId}@example.com` },
		ownerId: userId,
		keyring: [...keyring],
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
		launcher: { startSignIn: async () => launched() },
	});

	expect(auth.state).toEqual({ status: 'signed-out' });
	auth[Symbol.dispose]();
});

test('cold-boot signed-in exposes ownerId and keyring immediately without profile data', () => {
	const setup = createStorage(cell());
	const auth = createOAuthAppAuth({
		baseURL: 'http://localhost:8787',
		clientId: 'client-1',
		now: () => now,
		persistedAuthStorage: setup.storage,
		launcher: { startSignIn: async () => launched() },
	});

	expect(auth.state).toEqual({
		status: 'signed-in',
		ownerId: asOwnerId('user-1'),
		keyring: [...keyring],
	});
	expect('email' in auth.state).toBe(false);
	auth[Symbol.dispose]();
});

test('startSignIn calls /api/session and writes both sections', async () => {
	const setup = createStorage(null);
	const fetches: string[] = [];
	const auth = createOAuthAppAuth({
		baseURL: 'http://localhost:8787',
		clientId: 'client-1',
		now: () => now,
		persistedAuthStorage: setup.storage,
		launcher: {
			startSignIn: async () =>
				completed({
					accessToken: 'sign-in-access',
					refreshToken: 'sign-in-refresh',
					accessTokenExpiresAt: now + 3_600_000,
				}),
		},
		fetch: async (input) => {
			fetches.push(String(input));
			return json(apiSessionBody('user-1'));
		},
	});

	const result = await auth.startSignIn();
	expect(result).toEqual(Ok(undefined));
	expect(fetches[0]).toBe('http://localhost:8787/api/session');
	expect(setup.saved[0]).toEqual({
		grant: {
			accessToken: 'sign-in-access',
			refreshToken: 'sign-in-refresh',
			accessTokenExpiresAt: now + 3_600_000,
		},
		userId: asUserId('user-1'),
		ownerId: asOwnerId('user-1'),
		keyring: [...keyring],
	});
	expect(auth.state).toMatchObject({
		status: 'signed-in',
	});
	expect('email' in auth.state).toBe(false);
	auth[Symbol.dispose]();
});

test('startSignIn with launched result does not install a session', async () => {
	const setup = createStorage(null);
	let fetches = 0;
	const auth = createOAuthAppAuth({
		baseURL: 'http://localhost:8787',
		clientId: 'client-1',
		now: () => now,
		persistedAuthStorage: setup.storage,
		launcher: { startSignIn: async () => launched() },
		fetch: async () => {
			fetches += 1;
			return json(apiSessionBody('user-1'));
		},
	});

	const result = await auth.startSignIn();

	expect(result).toEqual(Ok(undefined));
	expect(fetches).toBe(0);
	expect(setup.saved).toEqual([]);
	expect(auth.state).toEqual({ status: 'signed-out' });
	auth[Symbol.dispose]();
});

test('startSignIn publishes signed-out before installing a different owner', async () => {
	const setup = createStorage(cell({ userId: 'alice' }));
	const states: string[] = [];
	const auth = createOAuthAppAuth({
		baseURL: 'http://localhost:8787',
		clientId: 'client-1',
		now: () => now,
		persistedAuthStorage: setup.storage,
		launcher: {
			startSignIn: async () =>
				completed({
					accessToken: 'bob-access',
					refreshToken: 'bob-refresh',
					accessTokenExpiresAt: now + 3_600_000,
				}),
		},
		fetch: async () => json(apiSessionBody('bob')),
	});
	auth.onStateChange((state) => {
		states.push(
			state.status === 'signed-out'
				? 'signed-out'
				: `${state.status}:${state.ownerId}`,
		);
	});

	const result = await auth.startSignIn();

	expect(result).toEqual(Ok(undefined));
	expect(states).toEqual(['signed-out', 'signed-in:bob']);
	expect(setup.saved).toEqual([
		null,
		{
			grant: {
				accessToken: 'bob-access',
				refreshToken: 'bob-refresh',
				accessTokenExpiresAt: now + 3_600_000,
			},
			userId: asUserId('bob'),
			ownerId: asOwnerId('bob'),
			keyring: [...keyring],
		},
	]);
	expect(auth.state).toEqual({
		status: 'signed-in',
		ownerId: asOwnerId('bob'),
		keyring: [...keyring],
	});
	auth[Symbol.dispose]();
});

test('signOut during startSignIn prevents the in-flight grant from being installed', async () => {
	const setup = createStorage(null);
	let resolveApiSession!: (response: Response) => void;
	let markApiSessionRequested!: () => void;
	const apiSessionRequested = new Promise<void>((r) => {
		markApiSessionRequested = r;
	});
	const apiSessionPromise = new Promise<Response>((r) => {
		resolveApiSession = r;
	});
	const auth = createOAuthAppAuth({
		baseURL: 'http://localhost:8787',
		clientId: 'client-1',
		now: () => now,
		persistedAuthStorage: setup.storage,
		launcher: {
			startSignIn: async () =>
				completed({
					accessToken: 'bob-access',
					refreshToken: 'bob-refresh',
					accessTokenExpiresAt: now + 3_600_000,
				}),
		},
		fetch: async (input) => {
			if (String(input).endsWith('/api/session')) {
				markApiSessionRequested();
				return apiSessionPromise;
			}
			return new Response(null, { status: 204 });
		},
	});

	const signInPromise = auth.startSignIn();
	await apiSessionRequested;
	const signOutResult = await auth.signOut();
	expect(signOutResult).toEqual(Ok(undefined));
	expect(auth.state).toEqual({ status: 'signed-out' });

	resolveApiSession(json(apiSessionBody('bob')));
	expect(await signInPromise).toEqual(Ok(undefined));

	expect(setup.current).toBeNull();
	expect(setup.saved.at(-1)).toBeNull();
	expect(auth.state).toEqual({ status: 'signed-out' });
	auth[Symbol.dispose]();
});

test('concurrent startSignIn shares one launcher flight', async () => {
	const setup = createStorage(null);
	let signInAttempts = 0;
	let resolveLauncher!: (result: Result<OAuthLaunchResult, unknown>) => void;
	const launcherPromise = new Promise<Result<OAuthLaunchResult, unknown>>(
		(r) => {
			resolveLauncher = r;
		},
	);
	let apiSessionCalls = 0;
	let markLauncherStarted!: () => void;
	const launcherStarted = new Promise<void>((r) => {
		markLauncherStarted = r;
	});
	const auth = createOAuthAppAuth({
		baseURL: 'http://localhost:8787',
		clientId: 'client-1',
		now: () => now,
		persistedAuthStorage: setup.storage,
		launcher: {
			startSignIn: async () => {
				signInAttempts += 1;
				markLauncherStarted();
				return launcherPromise;
			},
		},
		fetch: async (input) => {
			if (String(input).endsWith('/api/session')) {
				apiSessionCalls += 1;
				return json(apiSessionBody('bob'));
			}
			return new Response(null, { status: 204 });
		},
	});

	const firstSignIn = auth.startSignIn();
	await launcherStarted;
	const secondSignIn = auth.startSignIn();

	expect(signInAttempts).toBe(1);
	resolveLauncher(
		completed({
			accessToken: 'bob-access',
			refreshToken: 'bob-refresh',
			accessTokenExpiresAt: now + 3_600_000,
		}),
	);

	expect(await firstSignIn).toEqual(Ok(undefined));
	expect(await secondSignIn).toEqual(Ok(undefined));
	expect(apiSessionCalls).toBe(1);
	expect(auth.state).toEqual({
		status: 'signed-in',
		ownerId: asOwnerId('bob'),
		keyring: [...keyring],
	});
	expect(setup.current).toEqual({
		grant: {
			accessToken: 'bob-access',
			refreshToken: 'bob-refresh',
			accessTokenExpiresAt: now + 3_600_000,
		},
		userId: asUserId('bob'),
		ownerId: asOwnerId('bob'),
		keyring: [...keyring],
	});
	auth[Symbol.dispose]();
});

for (const status of [401, 403] as const) {
	test(`/api/session ${status} pauses network auth without attaching a bearer`, async () => {
		const setup = createStorage(cell());
		const resourceAuths: Array<string | null> = [];
		const auth = createOAuthAppAuth({
			baseURL: 'http://localhost:8787',
			clientId: 'client-1',
			now: () => now,
			persistedAuthStorage: setup.storage,
			launcher: { startSignIn: async () => launched() },
			fetch: async (input, init) => {
				if (String(input).endsWith('/api/session')) {
					return new Response(null, { status });
				}
				resourceAuths.push(new Headers(init?.headers).get('authorization'));
				return new Response(null, { status: 204 });
			},
		});

		const response = await auth.fetch('http://localhost:8787/resource');

		expect(response.status).toBe(204);
		expect(resourceAuths).toEqual([null]);
		expect(auth.state).toEqual({
			status: 'reauth-required',
			ownerId: asOwnerId('user-1'),
			keyring: [...keyring],
		});
		expect(setup.current).toEqual(cell());
		auth[Symbol.dispose]();
	});
}

test('/api/session 503 leaves local auth signed-in without attaching a bearer', async () => {
	const setup = createStorage(cell());
	const resourceAuths: Array<string | null> = [];
	const auth = createOAuthAppAuth({
		baseURL: 'http://localhost:8787',
		clientId: 'client-1',
		now: () => now,
		persistedAuthStorage: setup.storage,
		launcher: { startSignIn: async () => launched() },
		fetch: async (input, init) => {
			if (String(input).endsWith('/api/session')) {
				return new Response(null, { status: 503 });
			}
			resourceAuths.push(new Headers(init?.headers).get('authorization'));
			return new Response(null, { status: 204 });
		},
	});

	const response = await auth.fetch('http://localhost:8787/resource');

	expect(response.status).toBe(204);
	expect(resourceAuths).toEqual([null]);
	expect(auth.state).toEqual({
		status: 'signed-in',
		ownerId: asOwnerId('user-1'),
		keyring: [...keyring],
	});
	expect(setup.current).toEqual(cell());
	auth[Symbol.dispose]();
});

test('stale /api/session verification after owner-switch sign-in cannot replace the new owner', async () => {
	const setup = createStorage(cell({ userId: 'alice' }));
	let resolveOldApiSession!: (response: Response) => void;
	const oldApiSessionPromise = new Promise<Response>((r) => {
		resolveOldApiSession = r;
	});
	const auth = createOAuthAppAuth({
		baseURL: 'http://localhost:8787',
		clientId: 'client-1',
		now: () => now,
		persistedAuthStorage: setup.storage,
		launcher: {
			startSignIn: async () =>
				completed({
					accessToken: 'bob-access',
					refreshToken: 'bob-refresh',
					accessTokenExpiresAt: now + 3_600_000,
				}),
		},
		fetch: async (input, init) => {
			const authorization = new Headers(init?.headers).get('authorization');
			if (String(input).endsWith('/api/session')) {
				if (authorization === 'Bearer access-token') {
					return oldApiSessionPromise;
				}
				return json(apiSessionBody('bob'));
			}
			return new Response(null, { status: 204 });
		},
	});

	const staleFetch = auth.fetch('http://localhost:8787/resource');
	await Promise.resolve();

	const result = await auth.startSignIn();
	expect(result).toEqual(Ok(undefined));
	expect(auth.state).toEqual({
		status: 'signed-in',
		ownerId: asOwnerId('bob'),
		keyring: [...keyring],
	});

	resolveOldApiSession(json(apiSessionBody('alice')));
	await staleFetch;

	expect(setup.current).toEqual({
		grant: {
			accessToken: 'bob-access',
			refreshToken: 'bob-refresh',
			accessTokenExpiresAt: now + 3_600_000,
		},
		userId: asUserId('bob'),
		ownerId: asOwnerId('bob'),
		keyring: [...keyring],
	});
	expect(auth.state).toEqual({
		status: 'signed-in',
		ownerId: asOwnerId('bob'),
		keyring: [...keyring],
	});
	auth[Symbol.dispose]();
});

test('refresh writes ONLY the grant section; identity + keyring byte-identical', async () => {
	const initial = cell({ grant: grant({ accessTokenExpiresAt: now + 1 }) });
	const setup = createStorage(initial);
	const auth = createOAuthAppAuth({
		baseURL: 'http://localhost:8787',
		clientId: 'client-1',
		now: () => now,
		persistedAuthStorage: setup.storage,
		launcher: { startSignIn: async () => launched() },
		fetch: async (input) => {
			if (String(input).endsWith('/api/session'))
				return json(apiSessionBody('user-1'));
			if (String(input).endsWith('/auth/oauth2/token')) {
				return oauthTokenResponse();
			}
			return new Response(null, { status: 204 });
		},
	});

	await auth.fetch('http://localhost:8787/resource');
	const last = setup.saved.at(-1);
	expect(last?.userId).toEqual(initial.userId);
	expect(last?.ownerId).toEqual(initial.ownerId);
	expect(last?.keyring).toEqual(initial.keyring);
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
		launcher: { startSignIn: async () => launched() },
		fetch: async (input) => {
			if (String(input).endsWith('/api/session'))
				return json(apiSessionBody('user-1'));
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

test('same-owner guard wipes the cell when /api/session returns a different owner', async () => {
	const setup = createStorage(cell({ userId: 'alice' }));
	const auth = createOAuthAppAuth({
		baseURL: 'http://localhost:8787',
		clientId: 'client-1',
		now: () => now,
		persistedAuthStorage: setup.storage,
		launcher: { startSignIn: async () => launched() },
		fetch: async (input) => {
			if (String(input).endsWith('/api/session'))
				return json(apiSessionBody('bob'));
			return new Response(null, { status: 204 });
		},
	});

	const response = await auth.fetch('http://localhost:8787/resource');
	expect(response.status).toBe(204);
	expect(setup.current).toBeNull();
	expect(auth.state).toEqual({ status: 'signed-out' });
	auth[Symbol.dispose]();
});

test('same-owner /api/session preserves state when keyring is unchanged', async () => {
	const setup = createStorage(cell());
	const auth = createOAuthAppAuth({
		baseURL: 'http://localhost:8787',
		clientId: 'client-1',
		now: () => now,
		persistedAuthStorage: setup.storage,
		launcher: { startSignIn: async () => launched() },
		fetch: async (input) => {
			if (String(input).endsWith('/api/session'))
				return json(apiSessionBody('user-1'));
			return new Response(null, { status: 204 });
		},
	});

	await auth.fetch('http://localhost:8787/resource');
	expect(setup.current).toEqual(cell());
	// No identity/keyring write should have happened: keyring unchanged.
	expect(setup.saved).toEqual([]);
	expect(auth.state).toMatchObject({ status: 'signed-in' });
	auth[Symbol.dispose]();
});

test('keyring rotation updates persisted keyring', async () => {
	const setup = createStorage(cell());
	const rotated: Keyring = [
		{
			version: 2,
			keyBytesBase64: 'AQECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=',
		},
		...keyring,
	];
	const auth = createOAuthAppAuth({
		baseURL: 'http://localhost:8787',
		clientId: 'client-1',
		now: () => now,
		persistedAuthStorage: setup.storage,
		launcher: { startSignIn: async () => launched() },
		fetch: async (input) => {
			if (String(input).endsWith('/api/session')) {
				return json({
					user: { id: 'user-1', email: 'user-1@example.com' },
					ownerId: 'user-1',
					keyring: rotated,
				});
			}
			return new Response(null, { status: 204 });
		},
	});

	await auth.fetch('http://localhost:8787/resource');
	const last = setup.saved.at(-1);
	expect(last?.userId).toEqual(asUserId('user-1'));
	expect(last?.ownerId).toEqual(asOwnerId('user-1'));
	expect(last?.keyring).toEqual(rotated);
	expect(last?.grant).toEqual(cell().grant);
	expect(auth.state).toEqual({
		status: 'signed-in',
		ownerId: asOwnerId('user-1'),
		keyring: rotated,
	});
	auth[Symbol.dispose]();
});

test('network gate: no Authorization header until /api/session confirms same owner', async () => {
	const setup = createStorage(cell());
	const seenAuth: Array<string | null> = [];
	let resolveApiSession!: (response: Response) => void;
	const apiSessionPromise = new Promise<Response>((r) => {
		resolveApiSession = r;
	});
	const auth = createOAuthAppAuth({
		baseURL: 'http://localhost:8787',
		clientId: 'client-1',
		now: () => now,
		persistedAuthStorage: setup.storage,
		launcher: { startSignIn: async () => launched() },
		fetch: async (input, init) => {
			if (String(input).endsWith('/api/session')) return apiSessionPromise;
			seenAuth.push(new Headers(init?.headers).get('authorization'));
			return new Response(null, { status: 204 });
		},
	});

	const fetchPromise = auth.fetch('http://localhost:8787/resource');
	await Promise.resolve();
	expect(seenAuth).toEqual([]);
	resolveApiSession(json(apiSessionBody('user-1')));
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
		launcher: { startSignIn: async () => launched() },
		fetch: async (input, init) => {
			fetches.push({
				url: String(input),
				authorization: new Headers(init?.headers).get('authorization'),
			});
			return json(apiSessionBody('user-1'));
		},
	});

	const response = await auth.fetch('/api/session');
	expect(response.status).toBe(200);
	expect(fetches).toEqual([
		{
			url: 'http://localhost:8787/api/session',
			authorization: 'Bearer access-token',
		},
		{
			url: 'http://localhost:8787/api/session',
			authorization: 'Bearer access-token',
		},
	]);
	auth[Symbol.dispose]();
});

test('auth.fetch preserves iterable init headers when attaching bearer', async () => {
	const setup = createStorage(cell());
	const seenHeaders: Array<{
		authorization: string | null;
		custom: string | null;
	}> = [];
	const auth = createOAuthAppAuth({
		baseURL: 'http://localhost:8787',
		clientId: 'client-1',
		now: () => now,
		persistedAuthStorage: setup.storage,
		launcher: { startSignIn: async () => launched() },
		fetch: async (input, init) => {
			if (String(input).endsWith('/api/session')) {
				return json(apiSessionBody('user-1'));
			}
			const headers = new Headers(init?.headers);
			seenHeaders.push({
				authorization: headers.get('authorization'),
				custom: headers.get('x-custom'),
			});
			return new Response(null, { status: 204 });
		},
	});

	await auth.fetch('http://localhost:8787/resource', {
		headers: new Map([['x-custom', 'from-map']]) as unknown as HeadersInit,
	});

	expect(seenHeaders).toEqual([
		{
			authorization: 'Bearer access-token',
			custom: 'from-map',
		},
	]);
	auth[Symbol.dispose]();
});

test('network gate: no WebSocket bearer protocol until /api/session confirms same owner', async () => {
	const setup = createStorage(cell());
	const { openings, WebSocketRecorder } = createWebSocketRecorder();
	let resolveApiSession!: (response: Response) => void;
	const apiSessionPromise = new Promise<Response>((r) => {
		resolveApiSession = r;
	});
	const auth = createOAuthAppAuth({
		baseURL: 'http://localhost:8787',
		clientId: 'client-1',
		now: () => now,
		persistedAuthStorage: setup.storage,
		launcher: { startSignIn: async () => launched() },
		WebSocket: WebSocketRecorder,
		fetch: async (input) => {
			if (String(input).endsWith('/api/session')) return apiSessionPromise;
			return new Response(null, { status: 204 });
		},
	});

	const socketPromise = auth.openWebSocket('ws://localhost:8787/sync', [
		'epicenter.v1',
	]);
	await Promise.resolve();
	expect(openings).toEqual([]);
	resolveApiSession(json(apiSessionBody('user-1')));
	await socketPromise;
	expect(openings).toEqual([
		{
			url: 'ws://localhost:8787/sync',
			protocols: ['epicenter.v1', `${BEARER_SUBPROTOCOL_PREFIX}access-token`],
		},
	]);
	auth[Symbol.dispose]();
});

test('cold-boot offline keeps signed-in with cached ownerId and keyring and no profile field', async () => {
	const setup = createStorage(cell());
	const auth = createOAuthAppAuth({
		baseURL: 'http://localhost:8787',
		clientId: 'client-1',
		now: () => now,
		persistedAuthStorage: setup.storage,
		launcher: { startSignIn: async () => launched() },
		fetch: async () => {
			throw new Error('offline');
		},
	});

	expect(auth.state).toMatchObject({
		status: 'signed-in',
	});
	expect('email' in auth.state).toBe(false);
	expect(auth.state).toMatchObject({
		ownerId: asOwnerId('user-1'),
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
		launcher: { startSignIn: async () => launched() },
		fetch: async (input, init) => {
			if (String(input).endsWith('/api/session'))
				return json(apiSessionBody('user-1'));
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
			ownerId: asOwnerId('user-1'),
			keyring: [...keyring],
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

test('network verification clears on grant refresh until /api/session confirms new cell', async () => {
	const setup = createStorage(cell());
	const resourceAuths: Array<string | null> = [];
	const apiSessionAuths: Array<string | null> = [];
	let apiSessionCalls = 0;
	let resolveSecondApiSession!: (response: Response) => void;
	let markSecondApiSessionRequested!: () => void;
	const secondApiSessionPromise = new Promise<Response>((r) => {
		resolveSecondApiSession = r;
	});
	const secondApiSessionRequested = new Promise<void>((r) => {
		markSecondApiSessionRequested = r;
	});
	const auth = createOAuthAppAuth({
		baseURL: 'http://localhost:8787',
		clientId: 'client-1',
		now: () => now,
		persistedAuthStorage: setup.storage,
		launcher: { startSignIn: async () => launched() },
		fetch: async (input, init) => {
			const authorization = new Headers(init?.headers).get('authorization');
			if (String(input).endsWith('/api/session')) {
				apiSessionCalls += 1;
				apiSessionAuths.push(authorization);
				if (apiSessionCalls === 1) return json(apiSessionBody('user-1'));
				markSecondApiSessionRequested();
				return secondApiSessionPromise;
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
	await secondApiSessionRequested;
	expect(auth.state).toEqual({
		status: 'signed-in',
		ownerId: asOwnerId('user-1'),
		keyring: [...keyring],
	});
	expect('email' in auth.state).toBe(false);
	expect(resourceAuths).toEqual(['Bearer access-token', 'Bearer access-token']);
	expect(apiSessionAuths).toEqual(['Bearer access-token', 'Bearer new-access']);

	resolveSecondApiSession(json(apiSessionBody('user-1')));
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
		launcher: { startSignIn: async () => launched() },
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

test('signOut remains the final storage write when refresh persistence is in flight', async () => {
	const initial = cell({ grant: grant({ accessTokenExpiresAt: now + 1 }) });
	let current: PersistedAuth | null = initial;
	const saved: Array<PersistedAuth | null> = [];
	let markRefreshWriteStarted!: () => void;
	let resolveRefreshWrite!: () => void;
	const refreshWriteStarted = new Promise<void>((r) => {
		markRefreshWriteStarted = r;
	});
	const refreshWriteCanFinish = new Promise<void>((r) => {
		resolveRefreshWrite = r;
	});
	const storage: PersistedAuthStorage = {
		get: () => current,
		set: async (next) => {
			if (next?.grant.accessToken === 'new-access') {
				markRefreshWriteStarted();
				await refreshWriteCanFinish;
			}
			current = next;
			saved.push(next);
		},
	};
	const resourceAuths: Array<string | null> = [];
	const auth = createOAuthAppAuth({
		baseURL: 'http://localhost:8787',
		clientId: 'client-1',
		now: () => now,
		persistedAuthStorage: storage,
		launcher: { startSignIn: async () => launched() },
		fetch: async (input, init) => {
			if (String(input).endsWith('/auth/oauth2/token')) {
				return oauthTokenResponse();
			}
			if (String(input).endsWith('/auth/oauth2/revoke')) {
				return new Response(null, { status: 200 });
			}
			resourceAuths.push(new Headers(init?.headers).get('authorization'));
			return new Response(null, { status: 204 });
		},
	});

	const fetchPromise = auth.fetch('http://localhost:8787/resource');
	await refreshWriteStarted;
	const signOutPromise = auth.signOut();
	await Promise.resolve();

	resolveRefreshWrite();
	await Promise.all([fetchPromise, signOutPromise]);

	expect(current).toBeNull();
	expect(saved.at(-1)).toBeNull();
	expect(resourceAuths).toEqual([null]);
	expect(auth.state).toEqual({ status: 'signed-out' });
	auth[Symbol.dispose]();
});

test('/api/session response after signOut is discarded without corrupting state', async () => {
	const setup = createStorage(cell());
	const resourceAuths: Array<string | null> = [];
	let resolveApiSession!: (response: Response) => void;
	const apiSessionPromise = new Promise<Response>((r) => {
		resolveApiSession = r;
	});
	const auth = createOAuthAppAuth({
		baseURL: 'http://localhost:8787',
		clientId: 'client-1',
		now: () => now,
		persistedAuthStorage: setup.storage,
		launcher: { startSignIn: async () => launched() },
		fetch: async (input, init) => {
			if (String(input).endsWith('/api/session')) return apiSessionPromise;
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

	resolveApiSession(json(apiSessionBody('user-1')));
	await fetchPromise;
	expect(setup.current).toBeNull();
	expect(auth.state).toEqual({ status: 'signed-out' });
	expect(resourceAuths).toEqual([null]);
	auth[Symbol.dispose]();
});

test('/api/session key update after signOut is discarded without writing identity or keyring', async () => {
	const setup = createStorage(cell());
	const rotated: Keyring = [
		{
			version: 2,
			keyBytesBase64: 'AQECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=',
		},
	];
	let resolveApiSession!: (response: Response) => void;
	const apiSessionPromise = new Promise<Response>((r) => {
		resolveApiSession = r;
	});
	const auth = createOAuthAppAuth({
		baseURL: 'http://localhost:8787',
		clientId: 'client-1',
		now: () => now,
		persistedAuthStorage: setup.storage,
		launcher: { startSignIn: async () => launched() },
		fetch: async (input, init) => {
			if (String(input).endsWith('/api/session')) return apiSessionPromise;
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

	resolveApiSession(
		json({
			user: { id: 'user-1', email: 'user-1@example.com' },
			ownerId: 'user-1',
			keyring: rotated,
		}),
	);
	await fetchPromise;
	expect(setup.current).toBeNull();
	expect(setup.saved).not.toContainEqual({
		grant: grant(),
		userId: asUserId('user-1'),
		ownerId: asOwnerId('user-1'),
		keyring: rotated,
	});
	expect(auth.state).toEqual({ status: 'signed-out' });
	auth[Symbol.dispose]();
});
