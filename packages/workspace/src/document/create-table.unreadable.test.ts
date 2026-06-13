/**
 * Unreadable Bucket + Stored Count Reconciliation Tests
 *
 * On an encrypted table, a row whose key version is absent from the keyring
 * decrypts to nothing. Before this work it was invisible everywhere:
 * `entries()` skipped it, `size` subtracted it, only a bare count recorded it.
 * This file verifies the fourth read state is now honest: the row appears in
 * `scan().unreadable` (id plus a reason), `storedCount()` includes it, and the
 * four scan buckets sum to that count so no stored entry can hide from reads.
 *
 * Key behaviors:
 * - an undecryptable blob lands in scan().unreadable with its id and reason
 * - storedCount() includes undecryptable entries (encrypted size no longer subtracts)
 * - the four-bucket sum identity holds:
 *     storedCount === rows + nonconforming + newerWriter + unreadable
 * - plaintext stores produce no unreadable bucket; the identity still holds
 *
 * See also:
 * - `create-table.scan.test.ts` for the rows/nonconforming/newerWriter split
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
	test('an undecryptable blob lands in scan().unreadable with its id and a reason', () => {
		const ydoc = new Y.Doc();
		const key1 = randomBytes(32);
		const key2 = randomBytes(32);
		const ykv = createEncryptedYkvLww<unknown>(ydoc, 'test-table');
		// The store can only decrypt key version 2; a version-1 blob is locked out.
		ykv.activateEncryption(new Map([[2, key2]]));
		const table = createTable(ykv, definition, 'test');

		const lockedBlob = createEncryptedBlob(
			{ id: 'locked', title: 'secret', _v: 1 },
			key1,
			'locked',
		);
		ykv.yarray.push([{ key: 'locked', val: lockedBlob, ts: 100 }]);

		const { rows, nonconforming, newerWriter, unreadable } = table.scan();

		expect(rows).toEqual([]);
		expect(nonconforming).toEqual([]);
		expect(newerWriter).toEqual([]);
		expect(unreadable).toHaveLength(1);
		const error = unreadable[0]!;
		expect(error.name).toBe('UnreadableRow');
		expect(error.id).toBe('locked');
		expect(error.reason).toBe('keyVersion=1 not in keyring [2]');
	});

	test('storedCount includes undecryptable entries and the four buckets sum to it', () => {
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

		const { rows, nonconforming, newerWriter, unreadable } = table.scan();

		expect(rows).toHaveLength(1);
		expect(nonconforming).toHaveLength(1);
		expect(newerWriter).toHaveLength(1);
		expect(unreadable).toHaveLength(1);

		// The raw stored count no longer subtracts the undecryptable entry, so the
		// four read states partition it exactly.
		expect(table.storedCount()).toBe(4);
		expect(table.storedCount()).toBe(
			rows.length +
				nonconforming.length +
				newerWriter.length +
				unreadable.length,
		);

		// has() means raw existence, so it agrees with storedCount across every
		// read state, including the undecryptable row that get() reports absent.
		const ids = ['good', 'bad', 'future', 'locked'];
		expect(ids.filter((id) => table.has(id)).length).toBe(table.storedCount());
		expect(table.has('locked')).toBe(true);
	});
});

describe('plaintext stores', () => {
	test('produce no unreadable bucket and the sum identity still holds', () => {
		const ydoc = new Y.Doc();
		const yarray = ydoc.getArray<{ key: string; val: unknown; ts: number }>(
			TableKey('test'),
		);
		const ykv = new YKeyValueLww<unknown>(yarray);
		const table = createTable(ykv, definition, 'test');

		table.set({ id: '1', title: 'a' });
		yarray.push([{ key: '2', val: { id: '2', title: 9, _v: 1 }, ts: 100 }]);

		const { rows, nonconforming, newerWriter, unreadable } = table.scan();

		expect(unreadable).toEqual([]);
		expect(table.storedCount()).toBe(2);
		expect(table.storedCount()).toBe(
			rows.length +
				nonconforming.length +
				newerWriter.length +
				unreadable.length,
		);
	});
});
