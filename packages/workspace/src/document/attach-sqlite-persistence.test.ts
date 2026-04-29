/**
 * Tests for `attachSqlitePersistence` (the writer side of the SQLite
 * persistence pair). Covers: WAL pragma is applied to the file so
 * concurrent readers can open `{ readonly: true }` without `SQLITE_BUSY`,
 * and the basic load/replay/clear/dispose round-trip.
 *
 * Read-only consumer behavior is tested in
 * `attach-sqlite-readonly-persistence.test.ts`.
 */

import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as Y from 'yjs';
import { attachSqlitePersistence } from './attach-sqlite-persistence.js';

let workdir: string;

beforeEach(() => {
	workdir = mkdtempSync(join(tmpdir(), 'attach-sqlite-persistence-'));
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

describe('attachSqlitePersistence', () => {
	test('writer enables WAL journal mode on the file', async () => {
		const filePath = join(workdir, 'wal.sqlite');
		const ydoc = new Y.Doc();
		const att = attachSqlitePersistence(ydoc, { filePath });
		await att.whenLoaded;

		expect(readJournalMode(filePath).toLowerCase()).toBe('wal');

		ydoc.destroy();
		await att.whenDisposed;
	});

	test('round-trip: writer state survives close and reopen', async () => {
		const filePath = join(workdir, 'roundtrip.sqlite');

		const writerDoc = new Y.Doc();
		const writer = attachSqlitePersistence(writerDoc, { filePath });
		await writer.whenLoaded;
		writerDoc.transact(() => {
			const m = writerDoc.getMap<number>('m');
			for (let i = 0; i < 100; i++) m.set(`k${i}`, i);
		});
		writerDoc.destroy();
		await writer.whenDisposed;

		const reopenDoc = new Y.Doc();
		const reopen = attachSqlitePersistence(reopenDoc, { filePath });
		await reopen.whenLoaded;
		const reopened = reopenDoc.getMap<number>('m');
		expect(reopened.size).toBe(100);
		expect(reopened.get('k0')).toBe(0);
		expect(reopened.get('k99')).toBe(99);
		reopenDoc.destroy();
		await reopen.whenDisposed;
	});

	test('clearLocal drops all updates from the file', async () => {
		const filePath = join(workdir, 'clear.sqlite');
		const writerDoc = new Y.Doc();
		const writer = attachSqlitePersistence(writerDoc, { filePath });
		await writer.whenLoaded;
		writerDoc.getMap<number>('m').set('k', 1);
		await writer.clearLocal();
		writerDoc.destroy();
		await writer.whenDisposed;

		// Reopening should see no rehydrated state.
		const reopenDoc = new Y.Doc();
		const reopen = attachSqlitePersistence(reopenDoc, { filePath });
		await reopen.whenLoaded;
		expect(reopenDoc.getMap<number>('m').size).toBe(0);
		reopenDoc.destroy();
		await reopen.whenDisposed;
	});
});
