import { describe, expect, test } from 'bun:test';
import { resolveEntry } from './resolve-entry';

const fakeEntry = (name: string) =>
	({ name, workspace: {} }) as Parameters<typeof resolveEntry>[0][number];

describe('resolveEntry', () => {
	test('auto-selects when only one entry exists', () => {
		const notes = fakeEntry('notes');
		expect(resolveEntry([notes], undefined)).toEqual({
			data: notes,
			error: null,
		});
	});

	test('selects single entry by name when -w matches', () => {
		const notes = fakeEntry('notes');
		expect(resolveEntry([notes], 'notes')).toEqual({
			data: notes,
			error: null,
		});
	});

	test('returns UnknownWorkspace when -w typo does not match single entry', () => {
		const notes = fakeEntry('notes');
		const { error } = resolveEntry([notes], 'nots');
		expect(error?.name).toBe('UnknownWorkspace');
		if (error?.name === 'UnknownWorkspace') {
			expect(error.requested).toBe('nots');
			expect(error.available).toEqual(['notes']);
		}
	});

	test('selects by name with -w for multiple entries', () => {
		const tasks = fakeEntry('tasks');
		expect(resolveEntry([fakeEntry('notes'), tasks], 'tasks')).toEqual({
			data: tasks,
			error: null,
		});
	});

	test('returns AmbiguousWorkspace when multiple entries and no -w', () => {
		const entries = [fakeEntry('notes'), fakeEntry('tasks')];
		const { error } = resolveEntry(entries, undefined);
		expect(error?.name).toBe('AmbiguousWorkspace');
		if (error?.name === 'AmbiguousWorkspace') {
			expect(error.available).toEqual(['notes', 'tasks']);
		}
	});

	test('returns UnknownWorkspace when -w names a nonexistent entry', () => {
		const entries = [fakeEntry('notes'), fakeEntry('tasks')];
		const { error } = resolveEntry(entries, 'foo');
		expect(error?.name).toBe('UnknownWorkspace');
	});
});
