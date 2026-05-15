/**
 * attachEncryption tests: lazy keyring callback wires the workspace keyring
 * at every registration site (table, kv). Plaintext mode does not exist:
 * registration always activates encryption.
 *
 * Encrypted IndexedDB and owner-scoped behavior live on `createLocalOwner`;
 * see `local-owner.test.ts` for those round-trip tests.
 */

import { describe, expect, test } from 'bun:test';
import type { SubjectKeyring } from '@epicenter/encryption';
import { bytesToBase64 } from '@epicenter/encryption';
import { randomBytes } from '@noble/ciphers/utils.js';
import { type } from 'arktype';
import * as Y from 'yjs';
import { attachEncryption } from './attach-encryption.js';
import { defineTable } from './define-table.js';

function toKeyring(key: Uint8Array): SubjectKeyring {
	return [{ version: 1, subjectKeyBase64: bytesToBase64(key) }];
}

const encryptedRowDefinition = defineTable(
	type({ id: 'string', title: 'string', _v: '1' }),
);

function setup(keyring: SubjectKeyring = toKeyring(randomBytes(32))) {
	const ydoc = new Y.Doc({ guid: 'enc-test', gc: false });
	const encryption = attachEncryption(ydoc, { keyring: () => keyring });
	const tableA = encryption.attachTable('a', encryptedRowDefinition);
	const tableB = encryption.attachTable('b', encryptedRowDefinition);
	return { ydoc, tableA, tableB, encryption };
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

	test('late-registered store activates via keyring callback at registration time', () => {
		const keyring = toKeyring(randomBytes(32));
		const ydoc = new Y.Doc({ guid: 'enc-late-register', gc: false });
		const encryption = attachEncryption(ydoc, { keyring: () => keyring });

		// Initial table is registered.
		const earlyTable = encryption.attachTable('early', encryptedRowDefinition);
		earlyTable.set({ id: '1', title: 'Early', _v: 1 });

		// A later registration also calls keyring() and is encrypted from the start.
		const lateTable = encryption.attachTable('late', encryptedRowDefinition);

		lateTable.set({ id: '1', title: 'Written after late register', _v: 1 });
		expect(lateTable.get('1').data).toEqual({
			id: '1',
			title: 'Written after late register',
			_v: 1,
		});
	});

	test('keyring callback throwing at registration surfaces the throw', () => {
		const ydoc = new Y.Doc({ guid: 'enc-no-keys', gc: false });
		const encryption = attachEncryption(ydoc, {
			keyring: () => {
				throw new Error('not signed-in');
			},
		});
		expect(() => encryption.attachTable('a', encryptedRowDefinition)).toThrow(
			'not signed-in',
		);
	});

	test('attachReadonlyTable reads encrypted rows without exposing writes', () => {
		const keyring = toKeyring(randomBytes(32));
		const ydoc = new Y.Doc({ guid: 'enc-readonly-table', gc: false });
		const encryption = attachEncryption(ydoc, { keyring: () => keyring });
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
		const keyring = toKeyring(randomBytes(32));
		const ydoc = new Y.Doc({ guid: 'enc-readonly-tables', gc: false });
		const encryption = attachEncryption(ydoc, { keyring: () => keyring });
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
});
