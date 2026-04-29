/**
 * Unit tests for `buildTableActions` — the auto-generated CRUD action set.
 */
import { describe, expect, test } from 'bun:test';
import { type } from 'arktype';
import * as Y from 'yjs';
import { attachTable } from '../document/attach-table.js';
import { defineTable } from '../document/define-table.js';
import type { Brand } from 'wellcrafted/brand';
import { buildTableActions } from './table-actions.js';

type EntryId = string & Brand<'EntryId'>;
const EntryIdT = type('string').pipe((s): EntryId => s as EntryId);

const entries = defineTable(
	type({
		id: EntryIdT,
		title: 'string',
		tags: 'string[]',
		_v: '1',
	}),
);

function setupEntries() {
	const ydoc = new Y.Doc({ guid: 'test-table-actions' });
	const table = attachTable(ydoc, 'entries', entries);
	const actions = buildTableActions(table, 'entries');
	return { ydoc, table, actions };
}

describe('buildTableActions', () => {
	test('set / get / update / delete round-trip', () => {
		const { actions } = setupEntries();
		const id = 'e1' as EntryId;

		actions.set({ id, title: 'first', tags: [], _v: 1 as const });

		const fetched = actions.get({ id });
		expect(fetched.error).toBeNull();
		expect(fetched.data?.title).toBe('first');
		expect(fetched.data?.tags).toEqual([]);

		const updated = actions.update({ id, title: 'second' });
		expect(updated.error).toBeNull();
		expect(updated.data?.title).toBe('second');

		actions.delete({ id });
		const afterDelete = actions.get({ id });
		expect(afterDelete.error).toBeNull();
		expect(afterDelete.data).toBeNull();
	});

	test('getAllValid returns every row that parses', () => {
		const { actions } = setupEntries();
		actions.set({ id: 'a' as EntryId, title: 'A', tags: [], _v: 1 as const });
		actions.set({ id: 'b' as EntryId, title: 'B', tags: ['x'], _v: 1 as const });

		const all = actions.getAllValid();
		expect(all).toHaveLength(2);
		expect(all.map((r) => r.id as string).sort()).toEqual(['a', 'b']);
	});

	test('bulkSet inserts many rows', async () => {
		const { actions, table } = setupEntries();
		await actions.bulkSet({
			rows: [
				{ id: 'x' as EntryId, title: 'X', tags: [], _v: 1 as const },
				{ id: 'y' as EntryId, title: 'Y', tags: [], _v: 1 as const },
			],
		});
		expect(table.count()).toBe(2);
	});

	test('update.input accepts `{ id }` alone', () => {
		const { actions } = setupEntries();
		const schema = actions.update.input as unknown as ReturnType<
			typeof type
		>;
		const ok = (schema as unknown as (v: unknown) => unknown)({ id: 'x' });
		expect(ok instanceof type.errors).toBe(false);

		const noId = (schema as unknown as (v: unknown) => unknown)({
			title: 'no id',
		});
		expect(noId instanceof type.errors).toBe(true);

		const wrongV = (schema as unknown as (v: unknown) => unknown)({
			id: 'x',
			_v: 99,
		});
		expect(wrongV instanceof type.errors).toBe(true);
	});

	test('action metadata carries titles', () => {
		const { actions } = setupEntries();
		expect(actions.get.title).toBe('Get entries');
		expect(actions.update.title).toBe('Update entries');
		expect(actions.delete.title).toBe('Delete entries');
		expect(actions.bulkSet.title).toBe('Bulk set entries');
		expect(actions.set.type).toBe('mutation');
		expect(actions.get.type).toBe('query');
	});
});
