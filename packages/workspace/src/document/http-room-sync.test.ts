/**
 * Tests for readRoomOverHttp: the one-shot HTTP room read.
 *
 * A fake `fetch` stands in for the relay: GET returns a doc snapshot. The tests
 * prove the GET-seed-read shape (the seeded doc carries the snapshot state), that
 * a read never POSTs, and that a non-2xx response throws.
 */

import { describe, expect, test } from 'bun:test';
import { asOwnerId } from '@epicenter/identity';
import * as Y from 'yjs';
import type { AuthedFetch } from '../shared/types.js';
import { readRoomOverHttp } from './http-room-sync.js';

const baseURL = 'https://api.test';
const ownerId = asOwnerId('owner-1');
const guid = 'content-doc-1';

/** A fake relay: serves `snapshot` on GET, records POSTs. */
function fakeRelay({
	snapshot = new Uint8Array(0),
}: {
	snapshot?: Uint8Array;
} = {}) {
	const posts: Uint8Array[] = [];
	let getCount = 0;
	const fetch: AuthedFetch = async (_input, init) => {
		const method = init?.method ?? 'GET';
		if (method === 'GET') {
			getCount++;
			return new Response(snapshot as BodyInit);
		}
		posts.push(new Uint8Array(await new Response(init?.body).arrayBuffer()));
		return new Response(null, { status: 204 });
	};
	return {
		fetch,
		posts,
		get getCount() {
			return getCount;
		},
	};
}

describe('readRoomOverHttp', () => {
	test('GETs the snapshot and hands the seeded doc to read', async () => {
		const server = new Y.Doc();
		server.getMap('m').set('k', 'v');
		const snapshot = Y.encodeStateAsUpdateV2(server);
		const relay = fakeRelay({ snapshot });

		const value = await readRoomOverHttp({
			fetch: relay.fetch,
			baseURL,
			ownerId,
			guid,
			read: (ydoc) => ydoc.getMap('m').get('k'),
		});

		expect(value).toBe('v');
		expect(relay.getCount).toBe(1);
		// A read never POSTs.
		expect(relay.posts).toHaveLength(0);
	});

	test('throws on a non-2xx snapshot GET', async () => {
		const fetch: AuthedFetch = async () =>
			new Response('nope', { status: 500 });
		await expect(
			readRoomOverHttp({ fetch, baseURL, ownerId, guid, read: () => 0 }),
		).rejects.toThrow(/snapshot GET failed/);
	});
});
