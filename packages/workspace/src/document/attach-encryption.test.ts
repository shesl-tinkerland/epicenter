/**
 * attachEncryption tests: lazy encryptionKeys callback wires the keyring at every
 * registration site (table, kv, indexed-db). Plaintext mode does not exist:
 * registration always activates encryption.
 *
 * These tests exercise the attachment directly without a workspace client.
 * Stores are constructed through `encryption.attachTable`: the same pathway
 * used by application code.
 */

import { describe, expect, test } from 'bun:test';
import type { EncryptionKeys } from '@epicenter/encryption';
import {
	base64ToBytes,
	bytesToBase64,
	decryptBytes,
	deriveWorkspaceKey,
	type EncryptedBlob,
} from '@epicenter/encryption';
import { randomBytes } from '@noble/ciphers/utils.js';
import { type } from 'arktype';
import { IDBKeyRange, indexedDB } from 'fake-indexeddb';
import * as Y from 'yjs';
import { attachEncryption } from './attach-encryption.js';
import { defineTable } from './define-table.js';

Object.assign(globalThis, { indexedDB, IDBKeyRange });

function toEncryptionKeys(key: Uint8Array): EncryptionKeys {
	return [{ version: 1, userKeyBase64: bytesToBase64(key) }];
}

const encryptedRowDefinition = defineTable(
	type({ id: 'string', title: 'string', _v: '1' }),
);

function setup(keys: EncryptionKeys = toEncryptionKeys(randomBytes(32))) {
	const ydoc = new Y.Doc({ guid: 'enc-test', gc: false });
	const encryption = attachEncryption(ydoc, { encryptionKeys: () => keys });
	const tableA = encryption.attachTable('a', encryptedRowDefinition);
	const tableB = encryption.attachTable('b', encryptedRowDefinition);
	return { ydoc, tableA, tableB, encryption };
}

function tick(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

async function readEncryptedUpdates(dbName: string): Promise<EncryptedBlob[]> {
	const db = await new Promise<IDBDatabase>((resolve, reject) => {
		const request = indexedDB.open(dbName);
		request.onerror = () => reject(request.error);
		request.onsuccess = () => resolve(request.result);
	});
	try {
		const transaction = db.transaction(['updates'], 'readonly');
		const store = transaction.objectStore('updates');
		return await new Promise<EncryptedBlob[]>((resolve, reject) => {
			const request = store.getAll();
			request.onerror = () => reject(request.error);
			request.onsuccess = () => resolve(request.result as EncryptedBlob[]);
		});
	} finally {
		db.close();
	}
}

function keyringForGuid(
	keys: EncryptionKeys,
	guid: string,
): Map<number, Uint8Array> {
	return new Map(
		keys.map(({ version, userKeyBase64 }) => [
			version,
			deriveWorkspaceKey(base64ToBytes(userKeyBase64), guid),
		]),
	);
}

describe('attachEncryption', () => {
	test('registered stores accept encrypted writes immediately', () => {
		const { tableA, tableB } = setup();
		tableA.set({ id: '1', title: 'Secret A', _v: 1 });
		tableB.set({ id: '1', title: 'Secret B', _v: 1 });
		expect(tableA.get('1').data).toEqual({
			id: '1',
			title: 'Secret A',
			_v: 1,
		});
		expect(tableB.get('1').data).toEqual({
			id: '1',
			title: 'Secret B',
			_v: 1,
		});
	});

	test('late-registered store activates via encryptionKeys at registration time', () => {
		const keys = toEncryptionKeys(randomBytes(32));
		const ydoc = new Y.Doc({ guid: 'enc-late-register', gc: false });
		const encryption = attachEncryption(ydoc, { encryptionKeys: () => keys });

		// Initial table is registered.
		const earlyTable = encryption.attachTable('early', encryptedRowDefinition);
		earlyTable.set({ id: '1', title: 'Early', _v: 1 });

		// A later registration also calls encryptionKeys() and is encrypted from the start.
		const lateTable = encryption.attachTable('late', encryptedRowDefinition);

		lateTable.set({ id: '1', title: 'Written after late register', _v: 1 });
		expect(lateTable.get('1').data).toEqual({
			id: '1',
			title: 'Written after late register',
			_v: 1,
		});
	});

	test('encryptionKeys throwing at registration surfaces the throw', () => {
		const ydoc = new Y.Doc({ guid: 'enc-no-keys', gc: false });
		const encryption = attachEncryption(ydoc, {
			encryptionKeys: () => {
				throw new Error('not signed-in');
			},
		});
		expect(() => encryption.attachTable('a', encryptedRowDefinition)).toThrow(
			'not signed-in',
		);
	});

	test('attachReadonlyTable reads encrypted rows without exposing writes', () => {
		const keys = toEncryptionKeys(randomBytes(32));
		const ydoc = new Y.Doc({ guid: 'enc-readonly-table', gc: false });
		const encryption = attachEncryption(ydoc, { encryptionKeys: () => keys });
		const definition = defineTable(
			type({ id: 'string', title: 'string', _v: '1' }),
		);
		const writer = encryption.attachTable('entries', definition);
		const reader = encryption.attachReadonlyTable('entries', definition);

		writer.set({ id: '1', title: 'Secret row', _v: 1 });

		expect(reader.get('1').data).toEqual({
			id: '1',
			title: 'Secret row',
			_v: 1,
		});
		expect('set' in reader).toBe(false);
		expect('bulkSet' in reader).toBe(false);
		expect('update' in reader).toBe(false);
		expect('delete' in reader).toBe(false);
		expect('bulkDelete' in reader).toBe(false);
		expect('clear' in reader).toBe(false);
	});

	test('attachReadonlyTables returns readonly helpers keyed by definition', () => {
		const keys = toEncryptionKeys(randomBytes(32));
		const ydoc = new Y.Doc({ guid: 'enc-readonly-tables', gc: false });
		const encryption = attachEncryption(ydoc, { encryptionKeys: () => keys });
		const definition = defineTable(
			type({ id: 'string', title: 'string', _v: '1' }),
		);
		const writers = encryption.attachTables({ entries: definition });
		const readers = encryption.attachReadonlyTables({
			entries: definition,
		});

		writers.entries.set({ id: '1', title: 'Secret row', _v: 1 });

		expect(readers.entries.getAllValid()).toEqual([
			{ id: '1', title: 'Secret row', _v: 1 },
		]);
		expect('set' in readers.entries).toBe(false);
		expect('bulkSet' in readers.entries).toBe(false);
		expect('update' in readers.entries).toBe(false);
		expect('delete' in readers.entries).toBe(false);
		expect('bulkDelete' in readers.entries).toBe(false);
		expect('clear' in readers.entries).toBe(false);
	});

	describe('attachIndexedDb', () => {
		test('throws when encryptionKeys throws', () => {
			const ydoc = new Y.Doc({ guid: 'encrypted-idb-no-keys', gc: false });
			const encryption = attachEncryption(ydoc, {
				encryptionKeys: () => {
					throw new Error('not signed-in');
				},
			});

			expect(() =>
				encryption.attachIndexedDb(ydoc, {
					userId: 'user-no-keys',
				}),
			).toThrow('not signed-in');
		});

		test('round trips encrypted Yjs updates through IndexedDB', async () => {
			const userId = `user-${crypto.randomUUID()}`;
			const databaseName = `epicenter:v1:user:${userId}:yjs:encrypted-idb-roundtrip`;
			const keys = toEncryptionKeys(randomBytes(32));
			const firstDoc = new Y.Doc({
				guid: 'encrypted-idb-roundtrip',
				gc: false,
			});
			const firstEncryption = attachEncryption(firstDoc, {
				encryptionKeys: () => keys,
			});
			const firstIdb = firstEncryption.attachIndexedDb(firstDoc, {
				userId,
			});
			await firstIdb.whenLoaded;
			firstDoc.getText('body').insert(0, 'stored ciphertext');
			await tick();
			firstDoc.destroy();
			await firstIdb.whenDisposed;

			const rawUpdates = await readEncryptedUpdates(databaseName);
			expect(rawUpdates.length).toBeGreaterThan(0);
			expect(rawUpdates.every((update) => update[0] === 1)).toBe(true);

			const secondDoc = new Y.Doc({
				guid: 'encrypted-idb-roundtrip',
				gc: false,
			});
			const secondEncryption = attachEncryption(secondDoc, {
				encryptionKeys: () => keys,
			});
			const secondIdb = secondEncryption.attachIndexedDb(secondDoc, {
				userId,
			});
			await secondIdb.whenLoaded;

			expect(secondDoc.getText('body').toString()).toBe('stored ciphertext');
			secondDoc.destroy();
			await secondIdb.whenDisposed;
			await secondIdb.clearLocal();
		});

		test('target guid changes the derived storage key', async () => {
			const userId = `user-${crypto.randomUUID()}`;
			const databaseName = `epicenter:v1:user:${userId}:yjs:encrypted-idb-guid-a`;
			const keys = toEncryptionKeys(randomBytes(32));
			const ydoc = new Y.Doc({ guid: 'encrypted-idb-guid-a', gc: false });
			const encryption = attachEncryption(ydoc, { encryptionKeys: () => keys });
			const idb = encryption.attachIndexedDb(ydoc, { userId });
			await idb.whenLoaded;
			ydoc.getText('body').insert(0, 'guid bound');
			await tick();
			ydoc.destroy();
			await idb.whenDisposed;

			const rawUpdates = await readEncryptedUpdates(databaseName);
			const updateWithContent = rawUpdates.at(-1);
			expect(updateWithContent).toBeDefined();
			expect(() =>
				decryptBytes({
					keyring: keyringForGuid(keys, 'encrypted-idb-guid-b'),
					blob: updateWithContent as EncryptedBlob,
					aad: new TextEncoder().encode('yjs-update-v2:encrypted-idb-guid-a'),
				}),
			).toThrow();
			await idb.clearLocal();
		});

		test('clearLocal clears the encrypted IndexedDB database', async () => {
			const userId = `user-${crypto.randomUUID()}`;
			const keys = toEncryptionKeys(randomBytes(32));
			const firstDoc = new Y.Doc({ guid: 'encrypted-idb-clear', gc: false });
			const firstEncryption = attachEncryption(firstDoc, {
				encryptionKeys: () => keys,
			});
			const firstIdb = firstEncryption.attachIndexedDb(firstDoc, {
				userId,
			});
			await firstIdb.whenLoaded;
			firstDoc.getText('body').insert(0, 'clear me');
			await tick();
			firstDoc.destroy();
			await firstIdb.whenDisposed;
			await firstIdb.clearLocal();

			const secondDoc = new Y.Doc({ guid: 'encrypted-idb-clear', gc: false });
			const secondEncryption = attachEncryption(secondDoc, {
				encryptionKeys: () => keys,
			});
			const secondIdb = secondEncryption.attachIndexedDb(secondDoc, {
				userId,
			});
			await secondIdb.whenLoaded;

			expect(secondDoc.getText('body').toString()).toBe('');
			secondDoc.destroy();
			await secondIdb.whenDisposed;
			await secondIdb.clearLocal();
		});
	});
});
