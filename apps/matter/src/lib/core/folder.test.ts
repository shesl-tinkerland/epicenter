import { describe, expect, test } from 'bun:test';
import { readFolder } from './folder';

describe('readFolder', () => {
	test('splits readable rows from unreadable files and lists raw columns', () => {
		const result = readFolder([
			{ fileName: 'a.md', content: '---\ntitle: A\nrating: 5\n---\nbody' },
			{ fileName: 'b.md', content: '---\ntitle: B\n---\nbody' },
			{ fileName: 'broken.md', content: '---\ntitle: [unclosed\n---\nbody' },
			{
				fileName: 'conflict.md',
				content: '<<<<<<< HEAD\nx\n=======\ny\n>>>>>>> z\n',
			},
			{ fileName: 'raw.md', content: '# no frontmatter' },
		]);

		expect(result.rows.map((r) => r.fileName)).toEqual([
			'a.md',
			'b.md',
			'raw.md',
		]);
		expect(result.unreadable.map((u) => [u.fileName, u.error.name])).toEqual([
			['broken.md', 'InvalidYaml'],
			['conflict.md', 'ConflictMarkers'],
		]);
		// No model supplied: a raw untyped view, columns ordered by frequency then
		// first-seen, no type inference.
		expect(result.view.mode).toBe('unmodeled');
		if (result.view.mode !== 'unmodeled') throw new Error('expected unmodeled');
		expect(result.view.columns).toEqual(['title', 'rating']);
	});

	test('a valid matter.json produces a modeled view with per-cell conformance', () => {
		const model = JSON.stringify({
			fields: {
				title: { type: 'string' },
				rating: { type: 'integer' },
			},
		});
		const result = readFolder(
			[
				{ fileName: 'a.md', content: '---\ntitle: A\nrating: 5\n---\nbody' },
				{ fileName: 'b.md', content: '---\ntitle: B\n---\nbody' }, // rating absent -> MISSING_REQUIRED
				{
					fileName: 'c.md',
					content: '---\ntitle: C\nrating: "high"\n---\nbody',
				}, // INVALID
			],
			model,
		);

		expect(result.view.mode).toBe('modeled');
		if (result.view.mode !== 'modeled') throw new Error('expected modeled');
		const valid = result.view.conformance.map((c) => c.rowValid);
		expect(valid).toEqual([true, false, false]);
	});

	test('optional modeled fields can be absent or null without invalidating a row', () => {
		const model = JSON.stringify({
			fields: {
				title: { type: 'string' },
				reviewBy: { type: 'string', format: 'date' },
			},
			optional: ['reviewBy'],
		});
		const result = readFolder(
			[
				{ fileName: 'a.md', content: '---\ntitle: A\n---\nbody' },
				{ fileName: 'b.md', content: '---\ntitle: B\nreviewBy:\n---\nbody' },
			],
			model,
		);

		expect(result.view.mode).toBe('modeled');
		if (result.view.mode !== 'modeled') throw new Error('expected modeled');
		expect(result.view.conformance.map((c) => c.rowValid)).toEqual([
			true,
			true,
		]);
		expect(
			result.view.conformance.map((c) => c.cells.map((cell) => cell.state)),
		).toEqual([
			['OK', 'MISSING_OPTIONAL'],
			['OK', 'MISSING_OPTIONAL'],
		]);
	});

	test('a junk matter.json degrades to the raw view with a diagnostic', () => {
		const result = readFolder(
			[{ fileName: 'a.md', content: '---\ntitle: A\n---\nbody' }],
			'{ not json',
		);
		expect(result.view.mode).toBe('unmodeled');
		if (result.view.mode !== 'unmodeled') throw new Error('expected unmodeled');
		expect(result.view.modelError?.name).toBe('InvalidJson');
	});
});
