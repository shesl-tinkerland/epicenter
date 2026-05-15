/**
 * Machine auth tests.
 *
 * Covers loginWithOob / status / logout / createMachineAuthClient against
 * tmpfile-backed `~/.epicenter/auth.json` cells. Stubs `fetch` for both
 * `/auth/oauth2/token` (launcher) and `/api/me` (createOAuthAppAuth's
 * identity probe).
 */

import { afterEach, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { PersistedAuth } from '../auth-types.js';
import type { AuthFetch } from '../create-oauth-app-auth.js';
import {
	createMachineAuthClient,
	loginWithOob,
	logout,
	status,
} from './machine-auth.js';
import {
	loadMachineTokens,
	saveMachineTokens,
} from './machine-tokens-store.js';

const BASE_URL = 'http://localhost:8787';
const CLIENT_ID = 'epicenter-cli';
const NOW = 1_700_000_000_000;

const keyring = [
	{
		version: 1,
		subjectKeyBase64: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=',
	},
] as const;

const cleanupPaths: string[] = [];

function tmpAuthPath() {
	const filePath = path.join(
		os.tmpdir(),
		`epicenter-test-${randomUUID()}.json`,
	);
	cleanupPaths.push(filePath);
	return filePath;
}

afterEach(async () => {
	while (cleanupPaths.length) {
		const filePath = cleanupPaths.pop()!;
		try {
			await fs.unlink(filePath);
		} catch {
			// best effort
		}
		try {
			await fs.unlink(`${filePath}.tmp`);
		} catch {
			// best effort
		}
	}
});

function jsonResponse(value: unknown, init?: ResponseInit) {
	return new Response(JSON.stringify(value), {
		status: 200,
		...init,
		headers: { 'content-type': 'application/json', ...init?.headers },
	});
}

type RecordedRequest = {
	url: string;
	method: string;
	body: string | null;
	headers: Record<string, string>;
};

type Route = (request: RecordedRequest) => Response | Promise<Response>;

function createFetch({
	tokenRoute,
	apiMeRoute,
	revokeRoute,
}: {
	tokenRoute?: Route;
	apiMeRoute?: Route;
	revokeRoute?: Route;
} = {}): {
	fetch: AuthFetch;
	recorded: RecordedRequest[];
} {
	const recorded: RecordedRequest[] = [];
	const fetchImpl: AuthFetch = async (rawInput, rawInit) => {
		const input = rawInput;
		const init = rawInit;
		const url =
			typeof input === 'string'
				? input
				: input instanceof URL
					? input.toString()
					: input.url;
		const method = (init?.method ?? 'GET').toUpperCase();
		const body =
			init?.body == null
				? null
				: typeof init.body === 'string'
					? init.body
					: init.body instanceof URLSearchParams
						? init.body.toString()
						: null;
		const headers: Record<string, string> = {};
		if (init?.headers) {
			const h = new Headers(init.headers);
			h.forEach((value, key) => {
				headers[key.toLowerCase()] = value;
			});
		}
		const request: RecordedRequest = { url, method, body, headers };
		recorded.push(request);
		if (url.endsWith('/auth/oauth2/token') && tokenRoute) {
			return tokenRoute(request);
		}
		if (url.endsWith('/auth/oauth2/revoke') && revokeRoute) {
			return revokeRoute(request);
		}
		if (url.endsWith('/api/me') && apiMeRoute) {
			return apiMeRoute(request);
		}
		return new Response(null, { status: 404 });
	};
	return { fetch: fetchImpl, recorded };
}

function tokenSuccess(): Route {
	return () =>
		jsonResponse({
			access_token: 'access-1',
			refresh_token: 'refresh-1',
			expires_in: 3600,
			token_type: 'bearer',
		});
}

function apiMeOk(subject = 'user-1'): Route {
	return () =>
		jsonResponse({
			user: { id: subject, email: `${subject}@example.com` },
			localIdentity: { subject, keyring: [...keyring] },
		});
}

test('loginWithOob writes PersistedAuth and returns identity', async () => {
	const filePath = tmpAuthPath();
	const { fetch } = createFetch({
		tokenRoute: tokenSuccess(),
		apiMeRoute: apiMeOk('user-1'),
	});

	const result = await loginWithOob({
		baseURL: BASE_URL,
		clientId: CLIENT_ID,
		filePath,
		fetch,
		now: () => NOW,
		print: () => {},
		openBrowser: () => {},
		readCode: async () => 'CODE',
	});
	expect(result.error).toBeNull();
	expect(result.data?.identity.user).toEqual({
		id: 'user-1',
		email: 'user-1@example.com',
	});

	const loaded = await loadMachineTokens({ filePath });
	expect(loaded.error).toBeNull();
	expect(loaded.data).toEqual({
		grant: {
			accessToken: 'access-1',
			refreshToken: 'refresh-1',
			accessTokenExpiresAt: NOW + 3_600_000,
		},
		localIdentity: { subject: 'user-1', keyring: [...keyring] },
	});

	if (process.platform !== 'win32') {
		const stat = await fs.stat(filePath);
		expect(stat.mode & 0o777).toBe(0o600);
	}
});

test('loginWithOob with empty paste writes no file', async () => {
	const filePath = tmpAuthPath();
	const { fetch } = createFetch({
		tokenRoute: tokenSuccess(),
		apiMeRoute: apiMeOk(),
	});
	const result = await loginWithOob({
		baseURL: BASE_URL,
		clientId: CLIENT_ID,
		filePath,
		fetch,
		now: () => NOW,
		print: () => {},
		openBrowser: () => {},
		readCode: async () => '',
	});
	expect(result.error).toBeDefined();
	let exists = true;
	try {
		await fs.stat(filePath);
	} catch {
		exists = false;
	}
	expect(exists).toBe(false);
});

test('loginWithOob with /api/me 401 returns Err and writes no file', async () => {
	const filePath = tmpAuthPath();
	const { fetch } = createFetch({
		tokenRoute: tokenSuccess(),
		apiMeRoute: () => new Response(null, { status: 401 }),
	});
	const result = await loginWithOob({
		baseURL: BASE_URL,
		clientId: CLIENT_ID,
		filePath,
		fetch,
		now: () => NOW,
		print: () => {},
		openBrowser: () => {},
		readCode: async () => 'CODE',
	});
	expect(result.error).toBeDefined();
	let exists = true;
	try {
		await fs.stat(filePath);
	} catch {
		exists = false;
	}
	expect(exists).toBe(false);
});

async function preWriteCell(filePath: string, subject = 'user-1') {
	const cell: PersistedAuth = {
		grant: {
			accessToken: 'access-stored',
			refreshToken: 'refresh-stored',
			accessTokenExpiresAt: NOW + 3_600_000,
		},
		localIdentity: { subject, keyring: [...keyring] },
	};
	const { error } = await saveMachineTokens(cell, { filePath });
	if (error) throw error;
	return cell;
}

async function writeLegacyCell(filePath: string, userId = 'user-1') {
	const legacy = {
		grant: {
			accessToken: 'access-stored',
			refreshToken: 'refresh-stored',
			accessTokenExpiresAt: NOW + 3_600_000,
		},
		unlock: {
			userId,
			encryptionKeys: [
				{ version: 1, subjectKeyBase64: keyring[0].subjectKeyBase64 },
			],
		},
	};
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await fs.writeFile(filePath, JSON.stringify(legacy), { mode: 0o600 });
}

test('machine auth loads old auth.json shape', async () => {
	const filePath = tmpAuthPath();
	await writeLegacyCell(filePath, 'user-1');

	const loaded = await loadMachineTokens({ filePath });
	expect(loaded.error).toBeNull();
	expect(loaded.data).toEqual({
		grant: {
			accessToken: 'access-stored',
			refreshToken: 'refresh-stored',
			accessTokenExpiresAt: NOW + 3_600_000,
		},
		localIdentity: { subject: 'user-1', keyring: [...keyring] },
	});
});

test('sign-in writes the new persisted shape', async () => {
	const filePath = tmpAuthPath();
	const { fetch } = createFetch({
		tokenRoute: tokenSuccess(),
		apiMeRoute: apiMeOk('user-1'),
	});

	const result = await loginWithOob({
		baseURL: BASE_URL,
		clientId: CLIENT_ID,
		filePath,
		fetch,
		now: () => NOW,
		print: () => {},
		openBrowser: () => {},
		readCode: async () => 'CODE',
	});
	expect(result.error).toBeNull();
	const raw = await fs.readFile(filePath, 'utf-8');
	const parsed = JSON.parse(raw) as Record<string, unknown>;
	expect(Object.keys(parsed).sort()).toEqual(['grant', 'localIdentity']);
	expect('unlock' in parsed).toBe(false);
});

test('status valid when /api/me returns 200 with same subject', async () => {
	const filePath = tmpAuthPath();
	await preWriteCell(filePath, 'user-1');
	const { fetch } = createFetch({ apiMeRoute: apiMeOk('user-1') });
	const result = await status({
		baseURL: BASE_URL,
		clientId: CLIENT_ID,
		filePath,
		fetch,
		now: () => NOW,
	});
	expect(result.error).toBeNull();
	expect(result.data).toMatchObject({
		status: 'valid',
		identity: {
			user: { id: 'user-1', email: 'user-1@example.com' },
		},
	});
});

test('status unverified on network failure preserves cell', async () => {
	const filePath = tmpAuthPath();
	const cell = await preWriteCell(filePath, 'user-1');
	const fetchImpl: AuthFetch = async () => {
		throw new Error('network down');
	};
	const result = await status({
		baseURL: BASE_URL,
		clientId: CLIENT_ID,
		filePath,
		fetch: fetchImpl,
		now: () => NOW,
	});
	expect(result.error).toBeNull();
	expect(result.data?.status).toBe('unverified');
	const stillThere = await loadMachineTokens({ filePath });
	expect(stillThere.data).toEqual(cell);
});

test('status signedOut when no file', async () => {
	const filePath = tmpAuthPath();
	const { fetch } = createFetch();
	const result = await status({
		baseURL: BASE_URL,
		clientId: CLIENT_ID,
		filePath,
		fetch,
		now: () => NOW,
	});
	expect(result.error).toBeNull();
	expect(result.data).toEqual({ status: 'signedOut' });
});

test('same-subject guard wipes cell when /api/me returns different subject', async () => {
	const filePath = tmpAuthPath();
	await preWriteCell(filePath, 'alice');
	const { fetch } = createFetch({ apiMeRoute: apiMeOk('bob') });
	await status({
		baseURL: BASE_URL,
		clientId: CLIENT_ID,
		filePath,
		fetch,
		now: () => NOW,
	});
	let exists = true;
	try {
		await fs.stat(filePath);
	} catch {
		exists = false;
	}
	expect(exists).toBe(false);
});

test('logout revokes refresh token and deletes the file', async () => {
	const filePath = tmpAuthPath();
	await preWriteCell(filePath, 'user-1');
	const { fetch, recorded } = createFetch({
		revokeRoute: () => new Response(null, { status: 200 }),
	});
	const result = await logout({
		baseURL: BASE_URL,
		clientId: CLIENT_ID,
		filePath,
		fetch,
		now: () => NOW,
	});
	expect(result.error).toBeNull();
	expect(result.data).toEqual({ status: 'loggedOut' });
	const revoke = recorded.find((r) => r.url.endsWith('/auth/oauth2/revoke'));
	expect(revoke).toBeDefined();
	const body = new URLSearchParams(revoke!.body ?? '');
	expect(body.get('token')).toBe('refresh-stored');
	expect(body.get('token_type_hint')).toBe('refresh_token');
	expect(body.get('client_id')).toBe('epicenter-cli');
	let exists = true;
	try {
		await fs.stat(filePath);
	} catch {
		exists = false;
	}
	expect(exists).toBe(false);
});

test('logout survives revoke failure and still deletes the file', async () => {
	const filePath = tmpAuthPath();
	await preWriteCell(filePath, 'user-1');
	const { fetch } = createFetch({
		revokeRoute: () => new Response(null, { status: 503 }),
	});
	const result = await logout({
		baseURL: BASE_URL,
		clientId: CLIENT_ID,
		filePath,
		fetch,
		now: () => NOW,
	});
	expect(result.error).toBeNull();
	expect(result.data).toEqual({ status: 'loggedOut' });
	let exists = true;
	try {
		await fs.stat(filePath);
	} catch {
		exists = false;
	}
	expect(exists).toBe(false);
});

test('createMachineAuthClient throws when no file', async () => {
	const filePath = tmpAuthPath();
	const { fetch } = createFetch();
	let thrown: unknown = null;
	try {
		await createMachineAuthClient({
			baseURL: BASE_URL,
			clientId: CLIENT_ID,
			filePath,
			fetch,
			now: () => NOW,
		});
	} catch (cause) {
		thrown = cause;
	}
	expect(thrown).toBeInstanceOf(Error);
	expect((thrown as Error).message).toContain('epicenter auth login');
});

test('createMachineAuthClient loads file and attaches Bearer after gate', async () => {
	const filePath = tmpAuthPath();
	await preWriteCell(filePath, 'user-1');

	const recorded: RecordedRequest[] = [];
	const fetchImpl: AuthFetch = async (input, init) => {
		const url =
			typeof input === 'string'
				? input
				: input instanceof URL
					? input.toString()
					: input.url;
		const headers: Record<string, string> = {};
		if (init?.headers) {
			const h = new Headers(init.headers);
			h.forEach((value, key) => {
				headers[key.toLowerCase()] = value;
			});
		}
		recorded.push({
			url,
			method: (init?.method ?? 'GET').toUpperCase(),
			body: null,
			headers,
		});
		if (url.endsWith('/api/me')) {
			return jsonResponse({
				user: { id: 'user-1', email: 'user-1@example.com' },
				localIdentity: { subject: 'user-1', keyring: [...keyring] },
			});
		}
		if (url.endsWith('/api/something')) {
			return new Response(null, { status: 200 });
		}
		return new Response(null, { status: 404 });
	};

	const auth = await createMachineAuthClient({
		baseURL: BASE_URL,
		clientId: CLIENT_ID,
		filePath,
		fetch: fetchImpl,
		now: () => NOW,
	});
	const response = await auth.fetch('/api/something');
	expect(response.status).toBe(200);

	const meIndex = recorded.findIndex((r) => r.url.endsWith('/api/me'));
	const somethingIndex = recorded.findIndex((r) =>
		r.url.endsWith('/api/something'),
	);
	expect(meIndex).toBeGreaterThanOrEqual(0);
	expect(somethingIndex).toBeGreaterThanOrEqual(0);
	expect(meIndex).toBeLessThan(somethingIndex);

	const somethingReq = recorded[somethingIndex]!;
	expect(somethingReq.headers['authorization']).toBe('Bearer access-stored');
	auth[Symbol.dispose]();
});
