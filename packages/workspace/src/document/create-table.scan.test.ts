/**
 * Classified Scan Surface Tests
 *
 * Verifies `scan()`: the single O(n) read that resolves every stored entry
 * into one of four buckets (`rows`, `nonconforming`, `newerWriter`,
 * `unreadable`). Rows never silently vanish into a valid-only skip branch; the
 * issue buckets ride along in the same return value.
 *
 * Key behaviors:
 * - conforming rows land in `rows`; the issue buckets stay empty
 * - ValidationFailed and MigrationFailed rows land in `nonconforming`
 * - a `_v` above the binary's latest version lands in `newerWriter` as a
 *   distinct `NewerWriter` error carrying version and latestVersion
 * - UnknownVersion at or below the latest version (corrupt stamp) lands in `nonconforming`
 * - get() reports a newer-stamped row as NewerWriter, not UnknownVersion
 * - scan() exists on the readonly surface (read-only consumers report too)
 * - storedCount() includes nonconforming rows; scan().rows excludes them
 *
 * See also:
 * - `create-table.unreadable.test.ts` for the unreadable bucket and the
 *   four-bucket sum identity
 * - `create-table.write-guard.test.ts` for the write-side refusals
 */

import { describe, expect, test } from 'bun:test';
import { field } from '@epicenter/field';
import * as Y from 'yjs';
import { createEncryptedYkvLww } from '../shared/y-keyvalue/y-keyvalue-lww-encrypted.js';
import { defineTable } from './define-table.js';
import { createReadonlyTable, createTable } from './table.js';

function setup() {
	const ydoc = new Y.Doc();
	const ykv = createEncryptedYkvLww<unknown>(ydoc, 'test-table');
	const definition = defineTable({
		id: field.string(),
		title: field.string(),
	});
	const table = createTable(ykv, definition, 'test');
	return { ydoc, ykv, yarray: ykv.yarray, definition, table };
}

describe('scan', () => {
	test('conforming rows land in rows and the issue buckets stay empty', () => {
		const { table } = setup();
		table.set({ id: '1', title: 'a' });
		table.set({ id: '2', title: 'b' });

		const { rows, nonconforming, newerWriter, unreadable } = table.scan();

		expect(rows).toEqual([
			{ id: '1', title: 'a' },
			{ id: '2', title: 'b' },
		]);
		expect(nonconforming).toEqual([]);
		expect(newerWriter).toEqual([]);
		expect(unreadable).toEqual([]);
	});

	test('validation failures land in nonconforming with the raw row attached', () => {
		const { yarray, table } = setup();
		yarray.push([{ key: '1', val: { id: '1', title: 7, _v: 1 }, ts: 0 }]);

		const { rows, nonconforming, newerWriter } = table.scan();

		expect(rows).toEqual([]);
		expect(newerWriter).toEqual([]);
		expect(nonconforming).toHaveLength(1);
		const error = nonconforming[0]!;
		expect(error.name).toBe('ValidationFailed');
		if (error.name !== 'ValidationFailed')
			throw new Error('Expected ValidationFailed');
		expect(error.row).toEqual({ id: '1', title: 7, _v: 1 });
	});

	test('migration failures land in nonconforming', () => {
		const ydoc = new Y.Doc();
		const ykv = createEncryptedYkvLww<unknown>(ydoc, 'test-table');
		const definition = defineTable(
			{ id: field.string(), title: field.string() },
			{ id: field.string(), title: field.string(), views: field.number() },
		).migrate(({ value, version }) => {
			switch (version) {
				case 1:
					throw new Error('migration broke');
				case 2:
					return value;
			}
		});
		const table = createTable(ykv, definition, 'test');
		ykv.yarray.push([{ key: '1', val: { id: '1', title: 'a', _v: 1 }, ts: 0 }]);

		const { nonconforming, newerWriter } = table.scan();

		expect(newerWriter).toEqual([]);
		expect(nonconforming).toHaveLength(1);
		const error = nonconforming[0]!;
		expect(error.name).toBe('MigrationFailed');
		// Carries the raw stored value so the repair flow can rebuild the row.
		expect(error.row).toEqual({ id: '1', title: 'a', _v: 1 });
	});

	test('rows stamped above the latest known version land in newerWriter', () => {
		const { yarray, table } = setup();
		yarray.push([
			{
				key: '1',
				val: { id: '1', title: 'future', extra: true, _v: 2 },
				ts: 0,
			},
			{ key: '2', val: { id: '2', title: 'present', _v: 1 }, ts: 0 },
		]);

		const { rows, nonconforming, newerWriter } = table.scan();

		expect(rows).toHaveLength(1);
		expect(nonconforming).toEqual([]);
		expect(newerWriter).toHaveLength(1);
		const error = newerWriter[0]!;
		expect(error.name).toBe('NewerWriter');
		if (error.name !== 'NewerWriter') throw new Error('Expected NewerWriter');
		expect(error.version).toBe(2);
		expect(error.latestVersion).toBe(1);
		// The raw stored value is carried even though this binary cannot parse it.
		expect(error.row).toEqual({ id: '1', title: 'future', extra: true, _v: 2 });
	});

	test('get reports a newer-stamped row as NewerWriter, not UnknownVersion', () => {
		const { yarray, table } = setup();
		yarray.push([
			{ key: '1', val: { id: '1', title: 'future', _v: 2 }, ts: 0 },
		]);

		const { data, error } = table.get('1');

		expect(data).toBeNull();
		expect(error).not.toBeNull();
		if (!error) throw new Error('Expected an error');
		expect(error.name).toBe('NewerWriter');
		if (error.name !== 'NewerWriter') throw new Error('Expected NewerWriter');
		expect(error.id).toBe('1');
		expect(error.version).toBe(2);
		expect(error.latestVersion).toBe(1);
	});

	test('corrupt version stamps land in nonconforming, not newerWriter', () => {
		const { yarray, table } = setup();
		yarray.push([
			{ key: '1', val: { id: '1', title: 'zero', _v: 0 }, ts: 0 },
			{ key: '2', val: { id: '2', title: 'word', _v: 'banana' }, ts: 0 },
			{ key: '3', val: { id: '3', title: 'missing' }, ts: 0 },
		]);

		const { rows, nonconforming, newerWriter } = table.scan();

		expect(rows).toEqual([]);
		expect(newerWriter).toEqual([]);
		expect(nonconforming).toHaveLength(3);
		expect(nonconforming.every((e) => e.name === 'UnknownVersion')).toBe(true);
	});

	test('scan is available on the readonly surface', () => {
		const { ykv, yarray, definition } = setup();
		const readonly = createReadonlyTable(ykv, definition, 'test');
		yarray.push([{ key: '1', val: { id: '1', title: 'a', _v: 1 }, ts: 0 }]);

		expect(readonly.scan().rows).toHaveLength(1);
		expect('set' in readonly).toBe(false);
	});

	test('storedCount includes nonconforming rows while scan().rows excludes them', () => {
		const { yarray, table } = setup();
		table.set({ id: '1', title: 'good' });
		yarray.push([{ key: '2', val: { id: '2', title: 9, _v: 1 }, ts: 0 }]);

		expect(table.storedCount()).toBe(2);
		expect(table.scan().rows).toHaveLength(1);
	});
});
