/**
 * Matter Check Feature Tests
 *
 * Exercises the pure check feature with in-memory folder entries. These tests
 * pin the report projection separately from the package-script subprocess.
 *
 * Key behaviors:
 * - Missing optional cells count as empty, not findings
 * - Invalid values carry structured expected data for JSON consumers
 * - Fatal setup states are produced by the check feature
 */

import { describe, expect, test } from 'bun:test';
import { type CheckInput, check } from './check';
import { exitCodeFor } from './exit-code';

type FolderEntries = Extract<CheckInput, { kind: 'folder' }>['entries'];

const modelText = JSON.stringify({
	fields: {
		title: { type: 'string' },
		status: { enum: ['draft', 'ready', 'published'] },
		duration: { type: 'integer' },
		url: { type: 'string', format: 'uri' },
	},
	optional: ['url'],
});

function checkFolder(entries: FolderEntries) {
	return check({
		kind: 'folder',
		folder: 'memory',
		entries,
		model: { kind: 'loaded', text: modelText },
	});
}

describe('matter check feature', () => {
	test('missing optional cells count as empty without findings', () => {
		const result = checkFolder([
			{
				fileName: 'ready.md',
				content: '---\ntitle: Ready\nstatus: ready\nduration: 5\n---\nBody',
			},
		]);

		expect(result.status).toBe('checked');
		if (result.status !== 'checked') throw new Error('expected checked report');
		expect(exitCodeFor(result)).toBe(0);
		expect(result.findings).toEqual([]);
		expect(result.byField.find((field) => field.field === 'url')).toEqual({
			field: 'url',
			ok: 0,
			empty: 1,
			needsValue: 0,
			invalid: 0,
		});
	});

	test('invalid values carry structured expected data', () => {
		const result = checkFolder([
			{
				fileName: 'bad.md',
				content: '---\ntitle: Bad\nstatus: idea\nduration: five\n---\nBody',
			},
		]);

		expect(result.status).toBe('checked');
		if (result.status !== 'checked') throw new Error('expected checked report');
		expect(exitCodeFor(result)).toBe(1);
		expect(result.findings).toEqual([
			{
				file: 'bad.md',
				field: 'status',
				state: 'INVALID',
				actual: 'idea',
				expected: { kind: 'select', values: ['draft', 'ready', 'published'] },
			},
			{
				file: 'bad.md',
				field: 'duration',
				state: 'INVALID',
				actual: 'five',
				expected: { kind: 'integer' },
			},
		]);
	});

	test('missing matter.json returns a fatal report', () => {
		const result = check({
			kind: 'folder',
			folder: 'memory',
			entries: [],
			model: { kind: 'missing' },
		});

		expect(result).toEqual({
			version: 1,
			status: 'fatal',
			folder: 'memory',
			fatal: {
				code: 'MODEL_MISSING',
				message: 'matter.json is missing',
			},
		});
		expect(exitCodeFor(result)).toBe(2);
	});
});
