/**
 * Tests for `attachSqliteMirror` (the script-side read-only handle on the
 * daemon's SQLite materializer file). The daemon side is exercised via a real
 * `attachSqliteMaterializer` writing to an on-disk WAL file in a tmpdir; the
 * mirror reads the same file and asserts FTS5 lookups + raw row reads work.
 */

import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type } from 'arktype';
import * as Y from 'yjs';

import {
	attachTables,
	defineTable,
} from '../index.js';
import { attachSqliteMaterializer } from '../document/materializer/sqlite/sqlite.js';
import { attachSqliteMirror } from './sqlite-mirror.js';

const entriesTable = defineTable(
	type({
		id: 'string',
		_v: '1',
		title: 'string',
		body: 'string',
	}),
);

let workDir: string;

beforeEach(() => {
	workDir = mkdtempSync(join(tmpdir(), 'sqlite-mirror-'));
});

afterEach(() => {
	rmSync(workDir, { recursive: true, force: true });
});

async function seedMirrorFile(filePath: string, rows: Array<{ id: string; title: string; body: string }>) {
	const ydoc = new Y.Doc({ guid: 'test-mirror' });
	const tables = attachTables(ydoc, { entries: entriesTable });
	const writerDb = new Database(filePath);
	const materializer = attachSqliteMaterializer(ydoc, {
		db: writerDb,
		debounceMs: 0,
	}).table(tables.entries, { fts: ['title', 'body'] });
	await materializer.whenFlushed;
	for (const row of rows) tables.entries.set({ ...row, _v: 1 });
	// Force a flush by waiting a couple of microtasks past the debounce.
	await new Promise<void>((resolve) => setTimeout(resolve, 50));
	ydoc.destroy();
	writerDb.close();
}

describe('attachSqliteMirror', () => {
	test('opens the file read-only and reads materialized rows', async () => {
		const filePath = join(workDir, 'mirror.db');
		await seedMirrorFile(filePath, [
			{ id: 'a', title: 'Alpha', body: 'first entry' },
			{ id: 'b', title: 'Beta', body: 'second entry' },
		]);

		using mirror = attachSqliteMirror({ filePath });
		const rows = mirror.db
			.prepare('SELECT id, title FROM entries ORDER BY id')
			.all() as Array<{ id: string; title: string }>;
		expect(rows).toEqual([
			{ id: 'a', title: 'Alpha' },
			{ id: 'b', title: 'Beta' },
		]);
	});

	test('rejects writes through the read-only handle', async () => {
		const filePath = join(workDir, 'mirror.db');
		await seedMirrorFile(filePath, [
			{ id: 'a', title: 'Alpha', body: 'first' },
		]);

		using mirror = attachSqliteMirror({ filePath });
		expect(() =>
			mirror.db.run("INSERT INTO entries (id, title, body) VALUES ('c', 't', 'b')"),
		).toThrow();
	});

	test('search returns FTS5 hits with rank and snippet', async () => {
		const filePath = join(workDir, 'mirror.db');
		await seedMirrorFile(filePath, [
			{ id: 'a', title: 'Hello world', body: 'morning notes' },
			{ id: 'b', title: 'Goodbye', body: 'evening notes' },
			{ id: 'c', title: 'Hello again', body: 'morning followup' },
		]);

		using mirror = attachSqliteMirror({ filePath });
		const hits = await mirror.search('entries', 'hello');
		const ids = hits.map((h) => h.id).sort();
		expect(ids).toEqual(['a', 'c']);
		for (const hit of hits) {
			expect(hit.snippet).toContain('Hello');
			expect(typeof hit.rank).toBe('number');
		}
	});

	test('search returns empty array for missing FTS table', async () => {
		const filePath = join(workDir, 'empty.db');
		// Materializer with no FTS-indexed columns: the underlying table
		// exists but `entries_fts` does not.
		const ydoc = new Y.Doc({ guid: 'no-fts' });
		const tables = attachTables(ydoc, { entries: entriesTable });
		const writer = new Database(filePath);
		const m = attachSqliteMaterializer(ydoc, { db: writer, debounceMs: 0 }).table(
			tables.entries,
		);
		await m.whenFlushed;
		ydoc.destroy();
		writer.close();

		using mirror = attachSqliteMirror({ filePath });
		const hits = await mirror.search('entries', 'anything');
		expect(hits).toEqual([]);
	});

	test('dispose closes the database handle', async () => {
		const filePath = join(workDir, 'mirror.db');
		await seedMirrorFile(filePath, [
			{ id: 'a', title: 'Alpha', body: 'first' },
		]);

		const mirror = attachSqliteMirror({ filePath });
		mirror[Symbol.dispose]();
		// Subsequent search short-circuits without throwing.
		const hits = await mirror.search('entries', 'alpha');
		expect(hits).toEqual([]);
	});
});
