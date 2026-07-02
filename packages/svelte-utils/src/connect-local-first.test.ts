/**
 * Branch-selection guard for `connectLocalFirst`: the boot snapshot of
 * `auth.state` picks exactly one of two wirings, and the IndexedDB database
 * name proves which one ran (bare guid vs owner-scoped key).
 */

import { afterEach, expect, test } from 'bun:test';
import type { SyncAuthClient } from '@epicenter/auth';
import { asOwnerId } from '@epicenter/identity';
import { asNodeId } from '@epicenter/workspace';
import { IDBKeyRange, indexedDB } from 'fake-indexeddb';
import * as Y from 'yjs';
import { connectLocalFirst } from './connect-local-first.js';

Object.assign(globalThis, { indexedDB, IDBKeyRange });

class FakeBroadcastChannel {
	onmessage: ((event: MessageEvent) => void) | null = null;
	constructor(readonly name: string) {}
	postMessage(_message: unknown): void {}
	close(): void {}
}
Object.assign(globalThis, { BroadcastChannel: FakeBroadcastChannel });

const nodeId = asNodeId('node-test');

function stubAuth(state: SyncAuthClient['state']): SyncAuthClient {
	// Only the fields `connectLocalFirst` touches; the rest of the client
	// contract is irrelevant to branch selection.
	return {
		state,
		baseURL: 'https://api.example.com',
		openWebSocket: () => new Promise<never>(() => {}),
		onStateChange: () => () => {},
	} as unknown as SyncAuthClient;
}

async function databaseNames(): Promise<(string | undefined)[]> {
	const dbs = await indexedDB.databases();
	return dbs.map((db) => db.name);
}

const docs: Y.Doc[] = [];
afterEach(() => {
	for (const doc of docs.splice(0)) doc.destroy();
});

test('signed-out wires the bare guid database and no collaboration', async () => {
	const ydoc = new Y.Doc({ guid: 'clf-signed-out' });
	docs.push(ydoc);

	const { whenReady, collaboration } = connectLocalFirst({
		auth: stubAuth({ status: 'signed-out' }),
		ydoc,
		nodeId,
	});

	expect(collaboration).toBeUndefined();
	await whenReady;
	expect(await databaseNames()).toContain('clf-signed-out');
});

test('signed-in wires the owner-scoped database and collaboration', async () => {
	const ydoc = new Y.Doc({ guid: 'clf-signed-in' });
	docs.push(ydoc);

	const { whenReady, collaboration } = connectLocalFirst({
		auth: stubAuth({ status: 'signed-in', ownerId: asOwnerId('owner-1') }),
		ydoc,
		nodeId,
	});

	expect(collaboration).toBeDefined();
	await whenReady;
	expect(await databaseNames()).toContain(
		'epicenter/api.example.com/owners/owner-1/clf-signed-in',
	);
});

test('reauth-required behaves like signed-in (same owner, same doc)', async () => {
	const ydoc = new Y.Doc({ guid: 'clf-reauth' });
	docs.push(ydoc);

	const { collaboration } = connectLocalFirst({
		auth: stubAuth({
			status: 'reauth-required',
			ownerId: asOwnerId('owner-1'),
		}),
		ydoc,
		nodeId,
	});

	expect(collaboration).toBeDefined();
});
