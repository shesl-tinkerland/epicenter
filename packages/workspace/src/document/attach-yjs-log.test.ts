/**
 * Tests for `attachYjsLog` (the writer side of the SQLite
 * Yjs log pair). Covers: WAL pragma is applied to the file so
 * concurrent readers can open `{ readonly: true }` without `SQLITE_BUSY`,
 * and the basic load/replay/clear/dispose round-trip.
 *
 * Read-only consumer behavior is tested in
 * `attach-yjs-log-reader.test.ts`.
 */

import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as Y from 'yjs';
import { attachYjsLog } from './attach-yjs-log.js';

let workdir: string;

beforeEach(() => {
	workdir = mkdtempSync(join(tmpdir(), 'attach-yjs-log-'));
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

describe('attachYjsLog', () => {
	test('writer enables WAL journal mode on the file', async () => {
		const filePath = join(workdir, 'wal.sqlite');
		const ydoc = new Y.Doc();
		const att = attachYjsLog(ydoc, { filePath });

		expect(readJournalMode(filePath).toLowerCase()).toBe('wal');

		ydoc.destroy();
		await att.whenDisposed;
	});

	test('round-trip: writer state survives close and reopen', async () => {
		const filePath = join(workdir, 'roundtrip.sqlite');

		const writerDoc = new Y.Doc();
		const writer = attachYjsLog(writerDoc, { filePath });
		writerDoc.transact(() => {
			const m = writerDoc.getMap<number>('m');
			for (let i = 0; i < 100; i++) m.set(`k${i}`, i);
		});
		writerDoc.destroy();
		await writer.whenDisposed;

		const reopenDoc = new Y.Doc();
		const reopen = attachYjsLog(reopenDoc, { filePath });
		const reopened = reopenDoc.getMap<number>('m');
		expect(reopened.size).toBe(100);
		expect(reopened.get('k0')).toBe(0);
		expect(reopened.get('k99')).toBe(99);
		reopenDoc.destroy();
		await reopen.whenDisposed;
	});

	test('destroy compacts multiple update rows into one snapshot row', async () => {
		const filePath = join(workdir, 'compact-on-destroy.sqlite');
		const writerDoc = new Y.Doc();
		const writer = attachYjsLog(writerDoc, { filePath });
		const map = writerDoc.getMap<number>('m');

		for (let i = 0; i < 5; i++) map.set(`k${i}`, i);

		expect(countRows(filePath)).toBeGreaterThan(1);

		writerDoc.destroy();
		await writer.whenDisposed;

		expect(countRows(filePath)).toBe(1);

		const reopenDoc = new Y.Doc();
		const reopen = attachYjsLog(reopenDoc, { filePath });
		expect(reopenDoc.getMap<number>('m').get('k4')).toBe(4);
		reopenDoc.destroy();
		await reopen.whenDisposed;
	});

	test('clearLocal drops all updates from the file', async () => {
		const filePath = join(workdir, 'clear.sqlite');
		const writerDoc = new Y.Doc();
		const writer = attachYjsLog(writerDoc, { filePath });
		writerDoc.getMap<number>('m').set('k', 1);
		writer.clearLocal();
		writerDoc.destroy();
		await writer.whenDisposed;

		// Reopening should see no rehydrated state.
		const reopenDoc = new Y.Doc();
		const reopen = attachYjsLog(reopenDoc, { filePath });
		expect(reopenDoc.getMap<number>('m').size).toBe(0);
		reopenDoc.destroy();
		await reopen.whenDisposed;
	});
});
