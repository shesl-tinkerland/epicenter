/**
 * Write Guard Tests
 *
 * Verifies that whole-row writes refuse to clobber rows stamped by a newer
 * schema version than this binary knows. Without the guard, a stale binary's
 * `set()` whole-row-overwrites a newer-schema row with a fresh LWW timestamp,
 * destroying newer-only columns on every synced device (the local monotonic
 * clock guarantees the stale write wins LWW).
 *
 * Key behaviors:
 * - set() over a newer-stamped row returns Err(NewerWriterRefusal); the row survives
 * - set() over an unreadable (undecryptable) row returns Err(UnreadableRefusal); it survives
 * - set() over same-version, corrupt, or absent rows writes as before
 * - set()/clear() over a fractional `_v` above the latest repair it (a fraction
 *   is corruption, not a newer writer); read and write share one newer rule
 * - the guard reads the pending view inside an open transaction
 * - bulkSet() skips refused rows per chunk and reports them as TableWriteError; onProgress unchanged
 * - clear() skips newer-stamped and unreadable rows and reports them; delete(id) stays unguarded
 * - update() over a newer-stamped row refuses via NewerWriter (pinned)
 * - get() over an unreadable row reports UnreadableRow instead of absent
 *
 * See also:
 * - `create-table.test.ts` for core CRUD and migration behavior
 * - `create-table.unreadable.test.ts` for the read-side unreadable bucket
 */

import { describe, expect, test } from 'bun:test';
import { type EncryptedBlob, isEncryptedBlob } from '@epicenter/encryption';
import { field } from '@epicenter/field';
import { randomBytes } from '@noble/ciphers/utils.js';
import { expectErr, expectOk } from 'wellcrafted/testing';
import * as Y from 'yjs';
import { createEncryptedYkvLww } from '../shared/y-keyvalue/y-keyvalue-lww-encrypted.js';
import { defineTable } from './define-table.js';
import { createTable } from './table.js';

const v1Columns = {
	id: field.string(),
	title: field.string(),
};

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

/**
 * An encrypted v1 table holding one undecryptable row: the store's keyring has
 * only key version 2, but `locked` is a blob encrypted under version 1, so it
 * is present in storage yet this binary cannot read it.
 */
function setupWithLockedRow() {
	const ydoc = new Y.Doc();
	const key1 = randomBytes(32);
	const key2 = randomBytes(32);
	const ykv = createEncryptedYkvLww<unknown>(ydoc, 'test-table');
	ykv.activateEncryption(new Map([[2, key2]]));
	const table = createTable(ykv, defineTable(v1Columns), 'test');
	const lockedBlob = createEncryptedBlob(
		{ id: 'locked', title: 'secret', _v: 1 },
		key1,
		'locked',
	);
	ykv.yarray.push([{ key: 'locked', val: lockedBlob, ts: 100 }]);
	return { ydoc, ykv, table };
}

const v2Definition = defineTable(v1Columns, {
	id: field.string(),
	title: field.string(),
	rating: field.number(),
}).migrate(({ value, version }) => {
	switch (version) {
		case 1:
			return { ...value, rating: 0 };
		case 2:
			return value;
	}
});

/**
 * Two binaries over the same logical table: an old one that only knows v1
 * and a new one that knows v1 + v2. Each gets its own Y.Doc; `sync` pushes
 * updates between them like a relay would.
 */
function setupTwoBinaries() {
	const oldDoc = new Y.Doc();
	const newDoc = new Y.Doc();
	const oldYkv = createEncryptedYkvLww<unknown>(oldDoc, 'test-table');
	const newYkv = createEncryptedYkvLww<unknown>(newDoc, 'test-table');
	const oldTable = createTable(oldYkv, defineTable(v1Columns), 'test');
	const newTable = createTable(newYkv, v2Definition, 'test');
	const sync = (from: Y.Doc, to: Y.Doc) => {
		Y.applyUpdate(to, Y.encodeStateAsUpdate(from));
	};
	return { oldDoc, newDoc, oldYkv, newYkv, oldTable, newTable, sync };
}

/** Single-doc setup for guard behavior that does not need a second binary. */
function setup() {
	const ydoc = new Y.Doc();
	const ykv = createEncryptedYkvLww<unknown>(ydoc, 'test-table');
	const table = createTable(ykv, defineTable(v1Columns), 'test');
	return { ydoc, ykv, yarray: ykv.yarray, table };
}

describe('set write guard', () => {
	test('set over a newer-stamped row refuses and the newer columns survive sync', () => {
		const { oldDoc, newDoc, oldTable, newTable, sync } = setupTwoBinaries();

		newTable.set({ id: '1', title: 'From v2', rating: 5 });
		sync(newDoc, oldDoc);

		const error = expectErr(oldTable.set({ id: '1', title: 'Stale clobber' }));
		expect(error.name).toBe('NewerWriterRefusal');
		if (error.name !== 'NewerWriterRefusal')
			throw new Error('Expected NewerWriterRefusal');
		expect(error.id).toBe('1');
		expect(error.storedVersion).toBe(2);
		expect(error.latestVersion).toBe(1);

		// The refusal left the stored row untouched; syncing back changes nothing.
		sync(oldDoc, newDoc);
		const row = expectOk(newTable.get('1'));
		expect(row).toEqual({ id: '1', title: 'From v2', rating: 5 });
	});

	test('set over a same-version row replaces it', () => {
		const { table } = setup();

		expectOk(table.set({ id: '1', title: 'first' }));
		expectOk(table.set({ id: '1', title: 'second' }));

		expect(expectOk(table.get('1'))).toEqual({ id: '1', title: 'second' });
	});

	test('set over a corrupt stored value writes (overwrite is the repair)', () => {
		const { yarray, table } = setup();

		// Raw garbage: non-numeric _v and a non-object value under another key.
		yarray.push([{ key: '1', val: { id: '1', _v: 'banana' }, ts: 0 }]);
		yarray.push([{ key: '2', val: 'not even an object', ts: 0 }]);

		expectOk(table.set({ id: '1', title: 'repaired' }));
		expectOk(table.set({ id: '2', title: 'also repaired' }));
		expect(table.scan().nonconforming).toHaveLength(0);
	});

	test('set over a fractional-stamped row repairs it instead of refusing as newer', () => {
		const { yarray, table } = setup();

		// A fractional `_v` above the latest is corruption, never a newer writer:
		// no binary stamps a fraction. scan() classifies it as nonconforming, so
		// the write guard must let the overwrite through to repair it rather than
		// refuse it as NewerWriter. Read and write share one newer-writer rule.
		yarray.push([
			{ key: '1', val: { id: '1', title: 'corrupt', _v: 3.5 }, ts: 0 },
		]);

		expectOk(table.set({ id: '1', title: 'repaired' }));

		expect(expectOk(table.get('1'))).toEqual({ id: '1', title: 'repaired' });
		expect(table.scan().nonconforming).toHaveLength(0);
	});

	test('clear deletes a fractional-stamped row instead of refusing it as newer', () => {
		const { yarray, table } = setup();
		yarray.push([
			{ key: '1', val: { id: '1', title: 'corrupt', _v: 3.5 }, ts: 0 },
		]);

		const { refused } = table.clear();

		expect(refused).toEqual([]);
		expect(table.storedCount()).toBe(0);
	});

	test('guard reads the pending view inside an open transaction', () => {
		const { ydoc, ykv, table } = setup();

		ydoc.transact(() => {
			// Simulate a v2 row landing in the same transaction window: the
			// observer has not fired, so the value lives only in `pending`.
			ykv.set('1', { id: '1', title: 'newer', rating: 1, _v: 2 });
			const error = expectErr(table.set({ id: '1', title: 'stale' }));
			expect(error.name).toBe('NewerWriterRefusal');
		});

		// After the transaction, the v2 value is still the stored one.
		expect(ykv.get('1')).toEqual({ id: '1', title: 'newer', rating: 1, _v: 2 });
	});
});

describe('bulkSet write guard', () => {
	test('bulkSet writes conforming rows, reports refused ids, and keeps the progress contract', async () => {
		const { oldDoc, newDoc, oldTable, newTable, sync } = setupTwoBinaries();

		newTable.set({ id: '2', title: 'v2 row', rating: 3 });
		sync(newDoc, oldDoc);

		const progress: number[] = [];
		const { refused } = await oldTable.bulkSet(
			[
				{ id: '1', title: 'a' },
				{ id: '2', title: 'clobber attempt' },
				{ id: '3', title: 'c' },
				{ id: '4', title: 'd' },
				{ id: '5', title: 'e' },
			],
			{ chunkSize: 2, onProgress: (percent) => progress.push(percent) },
		);

		expect(refused.map((r) => ({ name: r.name, id: r.id }))).toEqual([
			{ name: 'NewerWriterRefusal', id: '2' },
		]);
		expect(progress).toEqual([0.4, 0.8, 1]);
		expect(
			oldTable
				.scan()
				.rows.map((r) => r.id)
				.sort(),
		).toEqual(['1', '3', '4', '5']);

		sync(oldDoc, newDoc);
		expect(expectOk(newTable.get('2'))).toEqual({
			id: '2',
			title: 'v2 row',
			rating: 3,
		});
	});
});

describe('destructive ops', () => {
	test('clear deletes conforming rows, skips newer-stamped rows, and reports them', () => {
		const { oldDoc, newDoc, oldTable, newTable, sync } = setupTwoBinaries();

		newTable.set({ id: 'keep', title: 'v2 row', rating: 9 });
		sync(newDoc, oldDoc);
		expectOk(oldTable.set({ id: 'gone-1', title: 'a' }));
		expectOk(oldTable.set({ id: 'gone-2', title: 'b' }));

		const { refused } = oldTable.clear();

		expect(refused.map((r) => ({ name: r.name, id: r.id }))).toEqual([
			{ name: 'NewerWriterRefusal', id: 'keep' },
		]);
		expect(oldTable.storedCount()).toBe(1);
		sync(oldDoc, newDoc);
		expect(expectOk(newTable.get('keep'))).toEqual({
			id: 'keep',
			title: 'v2 row',
			rating: 9,
		});
	});

	test('delete removes a newer-stamped row (deletion intent is shape-independent)', () => {
		const { oldDoc, newDoc, oldTable, newTable, sync } = setupTwoBinaries();

		newTable.set({ id: '1', title: 'v2 row', rating: 1 });
		sync(newDoc, oldDoc);

		oldTable.delete('1');

		expect(oldTable.has('1')).toBe(false);
		sync(oldDoc, newDoc);
		expect(expectOk(newTable.get('1'))).toBeNull();
	});
});

describe('update against newer-stamped rows', () => {
	test('update refuses with NewerWriter carrying the stored version', () => {
		const { oldDoc, newDoc, oldTable, newTable, sync } = setupTwoBinaries();

		newTable.set({ id: '1', title: 'v2 row', rating: 2 });
		sync(newDoc, oldDoc);

		const error = expectErr(oldTable.update('1', { title: 'stale edit' }));
		expect(error.name).toBe('NewerWriter');
		if (error.name !== 'NewerWriter') throw new Error('Expected NewerWriter');
		expect(error.version).toBe(2);
		expect(error.latestVersion).toBe(1);
	});
});

describe('unreadable row guard', () => {
	test('set over an unreadable row refuses and leaves the row intact', () => {
		const { ykv, table } = setupWithLockedRow();

		const error = expectErr(table.set({ id: 'locked', title: 'clobber' }));
		expect(error.name).toBe('UnreadableRefusal');
		if (error.name !== 'UnreadableRefusal')
			throw new Error('Expected UnreadableRefusal');
		expect(error.id).toBe('locked');
		expect(error.reason).toBe('keyVersion=1 not in keyring [2]');

		// The undecryptable blob is still in storage: the write was refused, not
		// silently overwritten.
		expect(table.scan().unreadable).toHaveLength(1);
		expect(ykv.get('locked')).toBeUndefined();
	});

	test('get over an unreadable row reports UnreadableRow, not absent', () => {
		const { table } = setupWithLockedRow();

		const { data, error } = table.get('locked');

		expect(data).toBeNull();
		expect(error).not.toBeNull();
		if (!error) throw new Error('Expected an error');
		expect(error.name).toBe('UnreadableRow');
		if (error.name !== 'UnreadableRow')
			throw new Error('Expected UnreadableRow');
		expect(error.id).toBe('locked');
		expect(error.reason).toBe('keyVersion=1 not in keyring [2]');
	});

	test('bulkSet refuses the unreadable row and writes the rest', async () => {
		const { table } = setupWithLockedRow();

		const { refused } = await table.bulkSet([
			{ id: 'locked', title: 'clobber attempt' },
			{ id: 'fresh', title: 'ok' },
		]);

		expect(refused.map((r) => ({ name: r.name, id: r.id }))).toEqual([
			{ name: 'UnreadableRefusal', id: 'locked' },
		]);
		expect(table.scan().rows.map((r) => r.id)).toEqual(['fresh']);
		expect(table.scan().unreadable).toHaveLength(1);
	});

	test('clear skips the unreadable row and reports it', () => {
		const { table } = setupWithLockedRow();
		expectOk(table.set({ id: 'gone', title: 'a' }));

		const { refused } = table.clear();

		expect(refused.map((r) => ({ name: r.name, id: r.id }))).toEqual([
			{ name: 'UnreadableRefusal', id: 'locked' },
		]);
		expect(table.scan().rows).toEqual([]);
		// The undecryptable blob survives clear().
		expect(table.scan().unreadable).toHaveLength(1);
	});

	test('delete removes an unreadable row (deletion intent is key-independent)', () => {
		const { table } = setupWithLockedRow();
		expect(table.scan().unreadable).toHaveLength(1);

		table.delete('locked');

		expect(table.scan().unreadable).toEqual([]);
		expect(table.storedCount()).toBe(0);
	});
});
