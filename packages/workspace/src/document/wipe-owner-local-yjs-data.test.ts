/**
 * Owner local Yjs data wipe tests.
 *
 * These tests verify that owner-scoped IndexedDB database names are deleted
 * through the public cleanup API without exposing dependency hooks to callers.
 *
 * Key behaviors:
 * - Known document guids are composed into owner-scoped database names.
 * - Enumerable owner-scoped database names are swept by owner prefix.
 * - Other owners and unscoped local documents are left alone.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { IDBKeyRange, indexedDB } from 'fake-indexeddb';
import { wipeOwnerLocalYjsData } from './attach-indexed-db.js';

Object.assign(globalThis, { indexedDB, IDBKeyRange });

async function createDatabase(name: string): Promise<void> {
	const database = await new Promise<IDBDatabase>((resolve, reject) => {
		const request = indexedDB.open(name);
		request.onerror = () => reject(request.error);
		request.onsuccess = () => resolve(request.result);
	});
	database.close();
}

async function deleteDatabase(name: string): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const request = indexedDB.deleteDatabase(name);
		request.onerror = () => reject(request.error);
		request.onsuccess = () => resolve();
		request.onblocked = () => reject(new Error(`Delete blocked for ${name}`));
	});
}

async function databaseNames(): Promise<string[]> {
	const databases = await indexedDB.databases();
	return databases
		.map((database) => database.name)
		.filter((name): name is string => typeof name === 'string');
}

describe('wipeOwnerLocalYjsData', () => {
	afterEach(async () => {
		await Promise.all((await databaseNames()).map((name) => deleteDatabase(name)));
	});

	test('clears known scoped document keys', async () => {
		await createDatabase('epicenter:v1:user:user-1:yjs:doc-a');
		await createDatabase('epicenter:v1:user:user-1:yjs:doc-b');

		await wipeOwnerLocalYjsData({
			userId: 'user-1',
			ydocGuids: ['doc-a', 'doc-b'],
		});

		expect(await databaseNames()).not.toContain(
			'epicenter:v1:user:user-1:yjs:doc-a',
		);
		expect(await databaseNames()).not.toContain(
			'epicenter:v1:user:user-1:yjs:doc-b',
		);
	});

	test('also clears enumerated scoped database names', async () => {
		await createDatabase('epicenter:v1:user:user-1:yjs:doc-a');
		await createDatabase('epicenter:v1:user:user-1:yjs:doc-b');
		await createDatabase('epicenter:v1:user:user-2:yjs:doc-c');
		await createDatabase('unscoped-doc');

		await wipeOwnerLocalYjsData({
			userId: 'user-1',
			ydocGuids: ['doc-a'],
		});

		expect(await databaseNames()).not.toContain(
			'epicenter:v1:user:user-1:yjs:doc-a',
		);
		expect(await databaseNames()).not.toContain(
			'epicenter:v1:user:user-1:yjs:doc-b',
		);
		expect(await databaseNames()).toContain(
			'epicenter:v1:user:user-2:yjs:doc-c',
		);
		expect(await databaseNames()).toContain('unscoped-doc');
	});
});
