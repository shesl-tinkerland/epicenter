/**
 * attachSqlite tests covering the file-backed persistence contract:
 *
 * - WAL journal mode is set on the writer file (so readers can open
 *   `{ readonly: true }` and run snapshot reads concurrently).
 * - Readonly mode replays existing rows but does not write or schedule
 *   compaction.
 * - Readonly fails fast when the file is missing rather than creating an
 *   empty database silently.
 *
 * Existing whenLoaded / whenDisposed / clearLocal behavior is exercised
 * indirectly via the writer round-trip; deeper coverage of compaction
 * lives next to the materializer.
 */

import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as Y from 'yjs';
import { attachSqlite } from './attach-sqlite.js';

let workdir: string;

beforeEach(() => {
	workdir = mkdtempSync(join(tmpdir(), 'attach-sqlite-'));
});

afterEach(() => {
	rmSync(workdir, { recursive: true, force: true });
});

function readJournalMode(filePath: string): string {
	const db = new Database(filePath, { readonly: true });
	try {
		const row = db.query('PRAGMA journal_mode').get() as {
			journal_mode: string;
		};
		return row.journal_mode;
	} finally {
		db.close();
	}
}

function countRows(filePath: string): number {
	const db = new Database(filePath, { readonly: true });
	try {
		const row = db.query('SELECT COUNT(*) as count FROM updates').get() as {
			count: number;
		};
		return row.count;
	} finally {
		db.close();
	}
}

describe('attachSqlite', () => {
	test('writer enables WAL journal mode on the file', async () => {
		const filePath = join(workdir, 'wal.sqlite');
		const ydoc = new Y.Doc();
		const att = attachSqlite(ydoc, { filePath });
		await att.whenLoaded;

		expect(readJournalMode(filePath).toLowerCase()).toBe('wal');

		ydoc.destroy();
		await att.whenDisposed;
	});

	test('readonly attachment replays writer state', async () => {
		const filePath = join(workdir, 'roundtrip.sqlite');

		const writerDoc = new Y.Doc();
		const writer = attachSqlite(writerDoc, { filePath });
		await writer.whenLoaded;

		const map = writerDoc.getMap<number>('m');
		writerDoc.transact(() => {
			for (let i = 0; i < 1000; i++) map.set(`k${i}`, i);
		});

		const readerDoc = new Y.Doc();
		const reader = attachSqlite(readerDoc, { filePath, readonly: true });
		await reader.whenLoaded;

		const readerMap = readerDoc.getMap<number>('m');
		expect(readerMap.size).toBe(1000);
		expect(readerMap.get('k0')).toBe(0);
		expect(readerMap.get('k999')).toBe(999);

		readerDoc.destroy();
		await reader.whenDisposed;
		writerDoc.destroy();
		await writer.whenDisposed;
	});

	test('readonly reader opens concurrently with active writer', async () => {
		const filePath = join(workdir, 'concurrent.sqlite');

		const writerDoc = new Y.Doc();
		const writer = attachSqlite(writerDoc, { filePath });
		await writer.whenLoaded;

		const map = writerDoc.getMap<number>('m');
		// Seed some state so the reader has something to replay.
		writerDoc.transact(() => {
			for (let i = 0; i < 100; i++) map.set(`seed${i}`, i);
		});

		// Background write loop running while the reader opens.
		let stop = false;
		let i = 0;
		const writes = (async () => {
			while (!stop) {
				map.set(`live${i++}`, i);
				await new Promise((r) => setTimeout(r, 1));
			}
		})();

		// Open a snapshot reader. With WAL this must not throw SQLITE_BUSY.
		const readerDoc = new Y.Doc();
		const reader = attachSqlite(readerDoc, { filePath, readonly: true });
		await reader.whenLoaded;

		const readerMap = readerDoc.getMap<number>('m');
		expect(readerMap.get('seed0')).toBe(0);
		expect(readerMap.get('seed99')).toBe(99);

		stop = true;
		await writes;

		readerDoc.destroy();
		await reader.whenDisposed;
		writerDoc.destroy();
		await writer.whenDisposed;
	});

	test('readonly throws synchronously when file is missing', () => {
		const filePath = join(workdir, 'does-not-exist.sqlite');
		const ydoc = new Y.Doc();
		expect(() =>
			attachSqlite(ydoc, { filePath, readonly: true }),
		).toThrow(/readonly mode requires existing file/);
	});

	test('readonly attachment does not write back to the file', async () => {
		const filePath = join(workdir, 'no-write.sqlite');

		const writerDoc = new Y.Doc();
		const writer = attachSqlite(writerDoc, { filePath });
		await writer.whenLoaded;
		writerDoc.getMap<number>('m').set('seed', 1);
		writerDoc.destroy();
		await writer.whenDisposed;

		const baselineRows = countRows(filePath);

		const readerDoc = new Y.Doc();
		const reader = attachSqlite(readerDoc, { filePath, readonly: true });
		await reader.whenLoaded;

		// Mutate the readonly-attached doc. No write listener means no INSERT.
		readerDoc.getMap<number>('m').set('mutation', 999);
		readerDoc.getMap<number>('m').set('mutation2', 1000);

		expect(countRows(filePath)).toBe(baselineRows);

		await expect(reader.clearLocal()).rejects.toThrow(
			/clearLocal disabled in readonly mode/,
		);

		readerDoc.destroy();
		await reader.whenDisposed;
	});
});
