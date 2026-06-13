/**
 * Unreadable Bucket + Stored Count Reconciliation Tests
 *
 * On an encrypted table, a row whose key version is absent from the keyring
 * decrypts to nothing. Before this wave it was invisible everywhere:
 * `entries()` skipped it, `size` subtracted it, only a bare count recorded it.
 * This file verifies the fourth read state is now honest: the row is
 * enumerable via the store's `unreadableEntries()` (id plus a reason), the raw
 * stored count includes it, and the four read states sum to that count so no
 * stored entry can hide from every read.
 *
 * Key behaviors:
 * - an undecryptable blob appears in unreadableEntries() with key and reason
 * - count() includes undecryptable entries (encrypted size no longer subtracts)
 * - the four-bucket sum identity holds:
 *     count === rows + nonconforming + newerWriter + unreadable
 * - plaintext stores enumerate no unreadable entries; the identity still holds
 *
 * See also:
 * - `create-table.conformance.test.ts` for the rows/nonconforming/newerWriter split
 * - `y-keyvalue-lww-encrypted.test.ts` for the store-level decrypt-skip behavior
 */

import { describe, expect, test } from 'bun:test';
import { type EncryptedBlob, isEncryptedBlob } from '@epicenter/encryption';
import { field } from '@epicenter/field';
import { randomBytes } from '@noble/ciphers/utils.js';
import * as Y from 'yjs';
import { createEncryptedYkvLww } from '../shared/y-keyvalue/y-keyvalue-lww-encrypted.js';
import { defineTable } from './define-table.js';
import { TableKey } from './keys.js';
import { createTable } from './table.js';
import { YKeyValueLww } from './y-keyvalue/index.js';

/** Encrypt a value into a standalone blob at key version 1 under `key`. */
function createEncryptedBlob(
	value: unknown,
	key: Uint8Array,
	entryKey: string,
): EncryptedBlob {
	const helperDoc = new Y.Doc({ guid: 'helper-blob' });
	const helperKv = createEncryptedYkvLww<unknown>(helperDoc, 'helper-data');
	helperKv.activateEncryption(new Map([[1, key]]));
	helperKv.set(entryKey, value);
	const entry = helperKv.yarray.toArray()[0];
	if (!entry || !isEncryptedBlob(entry.val))
		throw new Error('Expected encrypted helper entry');
	return entry.val;
}

const definition = defineTable({
	id: field.string(),
	title: field.string(),
});

describe('unreadable bucket', () => {
	test('an undecryptable blob is enumerable with its key and a reason', () => {
		const ydoc = new Y.Doc();
		const key1 = randomBytes(32);
		const key2 = randomBytes(32);
		const ykv = createEncryptedYkvLww<unknown>(ydoc, 'test-table');
		// The store can only decrypt key version 2; a version-1 blob is locked out.
		ykv.activateEncryption(new Map([[2, key2]]));

		const lockedBlob = createEncryptedBlob(
			{ id: 'locked', title: 'secret', _v: 1 },
			key1,
			'locked',
		);
		ykv.yarray.push([{ key: 'locked', val: lockedBlob, ts: 100 }]);

		const unreadable = [...ykv.unreadableEntries()];

		expect(unreadable).toEqual([
			{ key: 'locked', reason: 'keyVersion=1 not in keyring [2]' },
		]);
	});

	test('count includes undecryptable entries and the four buckets sum to it', () => {
		const ydoc = new Y.Doc();
		const key1 = randomBytes(32);
		const key2 = randomBytes(32);
		const ykv = createEncryptedYkvLww<unknown>(ydoc, 'test-table');
		ykv.activateEncryption(new Map([[2, key2]]));
		const table = createTable(ykv, definition, 'test');

		// conforming: encrypted under the active key, parses to the schema.
		table.set({ id: 'good', title: 'ok' });
		// nonconforming: a readable (plaintext-passthrough) row that fails validation.
		ykv.yarray.push([
			{ key: 'bad', val: { id: 'bad', title: 7, _v: 1 }, ts: 100 },
		]);
		// newerWriter: a readable row stamped above this binary's latest version.
		ykv.yarray.push([
			{ key: 'future', val: { id: 'future', title: 'x', _v: 2 }, ts: 100 },
		]);
		// unreadable: a blob whose key version is absent from the keyring.
		const lockedBlob = createEncryptedBlob(
			{ id: 'locked', title: 'secret', _v: 1 },
			key1,
			'locked',
		);
		ykv.yarray.push([{ key: 'locked', val: lockedBlob, ts: 100 }]);

		const { valid, nonconforming, newerWriter } = table.conformance();
		const unreadable = [...ykv.unreadableEntries()];

		expect(valid).toBe(1);
		expect(nonconforming).toHaveLength(1);
		expect(newerWriter).toHaveLength(1);
		expect(unreadable).toHaveLength(1);

		// The raw stored count no longer subtracts the undecryptable entry, so the
		// four read states partition it exactly.
		expect(table.count()).toBe(4);
		expect(table.count()).toBe(
			valid + nonconforming.length + newerWriter.length + unreadable.length,
		);
	});
});

describe('plaintext stores', () => {
	test('enumerate no unreadable entries and the sum identity still holds', () => {
		const ydoc = new Y.Doc();
		const yarray = ydoc.getArray<{ key: string; val: unknown; ts: number }>(
			TableKey('test'),
		);
		const ykv = new YKeyValueLww<unknown>(yarray);
		const table = createTable(ykv, definition, 'test');

		table.set({ id: '1', title: 'a' });
		yarray.push([{ key: '2', val: { id: '2', title: 9, _v: 1 }, ts: 100 }]);

		const { valid, nonconforming, newerWriter } = table.conformance();
		const unreadable = [...ykv.unreadableEntries()];

		expect(unreadable).toEqual([]);
		expect(table.count()).toBe(2);
		expect(table.count()).toBe(
			valid + nonconforming.length + newerWriter.length + unreadable.length,
		);
	});
});
