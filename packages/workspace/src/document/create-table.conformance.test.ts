/**
 * Conformance Surface Tests
 *
 * Verifies `conformance()`: the visible queue derived from the parse errors
 * the read path already computes. Rows never silently vanish into
 * `getAllValid()`'s skip branch without being countable somewhere.
 *
 * Key behaviors:
 * - valid rows count into `valid`; nothing lands in the queues
 * - ValidationFailed and MigrationFailed rows land in `nonconforming`
 * - a `_v` above the binary's latest version lands in `newerWriter` as a
 *   distinct `NewerWriter` error carrying version and latestVersion
 * - UnknownVersion at or below the latest version (corrupt stamp) lands in `nonconforming`
 * - conformance() exists on the readonly surface (read-only consumers report too)
 * - count() includes nonconforming rows; conformance().valid is the filtered count
 *
 * See also:
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

describe('conformance', () => {
	test('valid rows count into valid and both queues stay empty', () => {
		const { table } = setup();
		table.set({ id: '1', title: 'a' });
		table.set({ id: '2', title: 'b' });

		expect(table.conformance()).toEqual({
			valid: 2,
			nonconforming: [],
			newerWriter: [],
		});
	});

	test('validation failures land in nonconforming with the raw row attached', () => {
		const { yarray, table } = setup();
		yarray.push([{ key: '1', val: { id: '1', title: 7, _v: 1 }, ts: 0 }]);

		const { valid, nonconforming, newerWriter } = table.conformance();

		expect(valid).toBe(0);
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

		const { nonconforming, newerWriter } = table.conformance();

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
			{ key: '1', val: { id: '1', title: 'future', extra: true, _v: 2 }, ts: 0 },
			{ key: '2', val: { id: '2', title: 'present', _v: 1 }, ts: 0 },
		]);

		const { valid, nonconforming, newerWriter } = table.conformance();

		expect(valid).toBe(1);
		expect(nonconforming).toEqual([]);
		expect(newerWriter).toHaveLength(1);
		const error = newerWriter[0]!;
		expect(error.name).toBe('NewerWriter');
		if (error.name !== 'NewerWriter')
			throw new Error('Expected NewerWriter');
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

		const { valid, nonconforming, newerWriter } = table.conformance();

		expect(valid).toBe(0);
		expect(newerWriter).toEqual([]);
		expect(nonconforming).toHaveLength(3);
		expect(nonconforming.every((e) => e.name === 'UnknownVersion')).toBe(true);
	});

	test('conformance is available on the readonly surface', () => {
		const { ykv, yarray, definition } = setup();
		const readonly = createReadonlyTable(ykv, definition, 'test');
		yarray.push([{ key: '1', val: { id: '1', title: 'a', _v: 1 }, ts: 0 }]);

		expect(readonly.conformance().valid).toBe(1);
		expect('set' in readonly).toBe(false);
	});

	test('count includes nonconforming rows while conformance().valid filters them', () => {
		const { yarray, table } = setup();
		table.set({ id: '1', title: 'good' });
		yarray.push([{ key: '2', val: { id: '2', title: 9, _v: 1 }, ts: 0 }]);

		expect(table.count()).toBe(2);
		expect(table.conformance().valid).toBe(1);
	});
});
