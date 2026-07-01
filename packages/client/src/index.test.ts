import { afterEach, describe, expect, test } from 'bun:test';
import { asOwnerId } from '@epicenter/identity';
import { createEpicenterClient } from './index.js';

const baseURL = 'https://api.epicenter.so';

describe('blobs.add fails closed', () => {
	const originalFetch = globalThis.fetch;
	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	test('a 401 on the upload ticket returns an error and never PUTs bytes', async () => {
		// The owner-scoped client trusts its construction owner, but the first
		// authed request (the ticket POST) is where auth verifies it: on an owner
		// mismatch the auth client wipes the cell and withholds the bearer, so that
		// POST comes back 401. The client must stop there, before streaming any
		// bytes to the store. The store PUT goes through the global `fetch`, so we
		// fail the test if it is ever reached.
		let putReached = false;
		globalThis.fetch = (async () => {
			putReached = true;
			return new Response(null, { status: 200 });
		}) as unknown as typeof fetch;

		const ticketCalls: string[] = [];
		const client = createEpicenterClient({
			baseURL,
			ownerId: asOwnerId('owner-1'),
			fetch: async (input) => {
				ticketCalls.push(String(input));
				return new Response('unauthorized', { status: 401 });
			},
		});

		const { data, error } = await client.blobs.add(
			new Blob([new Uint8Array([1, 2, 3])], { type: 'text/plain' }),
		);

		expect(data).toBeNull();
		expect(error?.name).toBe('RequestFailed');
		if (error?.name === 'RequestFailed') {
			expect(error.status).toBe(401);
		}
		expect(putReached).toBe(false);
		expect(ticketCalls).toHaveLength(1);
	});
});

describe('blobs.get follows the 302 by hand', () => {
	const originalFetch = globalThis.fetch;
	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	test('a manual-redirect 302 is followed with the plain global fetch', async () => {
		// A bearer-authed fetch pins `redirect: 'manual'`, so the server's 302
		// surfaces raw. The client must read `Location` and hit the presigned URL
		// through the global `fetch` (no bearer), then hand back the bytes.
		const presignedUrl = 'https://store.example.com/owners/o/blobs/abc?sig=1';
		const storeCalls: string[] = [];
		globalThis.fetch = (async (input: string | URL | Request) => {
			storeCalls.push(String(input));
			return new Response('blob bytes', {
				status: 200,
				headers: { 'content-type': 'text/plain' },
			});
		}) as unknown as typeof fetch;

		const client = createEpicenterClient({
			baseURL,
			ownerId: asOwnerId('owner-1'),
			fetch: async () =>
				new Response(null, {
					status: 302,
					headers: { location: presignedUrl },
				}),
		});

		const { data, error } = await client.blobs.get('abc');

		expect(error).toBeNull();
		expect(await data?.text()).toBe('blob bytes');
		expect(storeCalls).toEqual([presignedUrl]);
	});

	test('a redirect without a Location header fails closed', async () => {
		let storeReached = false;
		globalThis.fetch = (async () => {
			storeReached = true;
			return new Response(null, { status: 200 });
		}) as unknown as typeof fetch;

		const client = createEpicenterClient({
			baseURL,
			ownerId: asOwnerId('owner-1'),
			fetch: async () => new Response(null, { status: 302 }),
		});

		const { data, error } = await client.blobs.get('abc');

		expect(data).toBeNull();
		expect(error?.name).toBe('RequestFailed');
		if (error?.name === 'RequestFailed') {
			expect(error.status).toBe(302);
		}
		expect(storeReached).toBe(false);
	});

	test('a 2xx from a redirect-following fetch is returned as-is', async () => {
		// A cookie-authed browser fetch follows the redirect itself; the client
		// must not fetch again.
		let storeReached = false;
		globalThis.fetch = (async () => {
			storeReached = true;
			return new Response(null, { status: 200 });
		}) as unknown as typeof fetch;

		const client = createEpicenterClient({
			baseURL,
			ownerId: asOwnerId('owner-1'),
			fetch: async () => new Response('blob bytes', { status: 200 }),
		});

		const { data, error } = await client.blobs.get('abc');

		expect(error).toBeNull();
		expect(await data?.text()).toBe('blob bytes');
		expect(storeReached).toBe(false);
	});
});
