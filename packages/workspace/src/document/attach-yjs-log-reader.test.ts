/**
 * Tests for `attachYjsLogReader` (the reader side of the
 * SQLite persistence pair). Covers: round-trip from a writer file,
 * concurrent open against an active writer (WAL snapshot reads),
 * missing-file no-op via `fileExisted`, and the no-write-listener invariant.
 */

import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as Y from 'yjs';
import { attachYjsLog } from './attach-yjs-log.js';
import { attachYjsLogReader } from './attach-yjs-log-reader.js';

let workdir: string;

beforeEach(() => {
	workdir = mkdtempSync(join(tmpdir(), 'attach-yjs-log-reader-'));
});

afterEach(() => {
	rmSync(workdir, { recursive: true, force: true });
});

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

describe('attachYjsLogReader', () => {
	test('replays writer state into the reader Y.Doc', async () => {
		const filePath = join(workdir, 'roundtrip.sqlite');

		const writerDoc = new Y.Doc();
		const writer = attachYjsLog(writerDoc, { filePath });

		const map = writerDoc.getMap<number>('m');
		writerDoc.transact(() => {
			for (let i = 0; i < 1000; i++) map.set(`k${i}`, i);
		});

		const readerDoc = new Y.Doc();
		const reader = attachYjsLogReader(readerDoc, { filePath });

		expect(reader.fileExisted).toBe(true);
		const readerMap = readerDoc.getMap<number>('m');
		expect(readerMap.size).toBe(1000);
		expect(readerMap.get('k0')).toBe(0);
		expect(readerMap.get('k999')).toBe(999);

		readerDoc.destroy();
		await reader.whenDisposed;
		writerDoc.destroy();
		await writer.whenDisposed;
	});

	test('opens concurrently with an active writer (WAL snapshot read)', async () => {
		const filePath = join(workdir, 'concurrent.sqlite');

		const writerDoc = new Y.Doc();
		const writer = attachYjsLog(writerDoc, { filePath });

		const map = writerDoc.getMap<number>('m');
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

		const readerDoc = new Y.Doc();
		const reader = attachYjsLogReader(readerDoc, { filePath });

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

	test('missing file is a no-op: fileExisted is false, doc stays empty', async () => {
		const filePath = join(workdir, 'does-not-exist.sqlite');
		const ydoc = new Y.Doc();
		const att = attachYjsLogReader(ydoc, { filePath });
		expect(att.fileExisted).toBe(false);
		expect(ydoc.getMap('m').size).toBe(0);
		ydoc.destroy();
		await att.whenDisposed;
	});

	test('does not write back to the file', async () => {
		const filePath = join(workdir, 'no-write.sqlite');

		const writerDoc = new Y.Doc();
		const writer = attachYjsLog(writerDoc, { filePath });
		writerDoc.getMap<number>('m').set('seed', 1);
		writerDoc.destroy();
		await writer.whenDisposed;

		const baselineRows = countRows(filePath);

		const readerDoc = new Y.Doc();
		const reader = attachYjsLogReader(readerDoc, { filePath });

		// Mutate the readonly-attached doc. No write listener means no INSERT.
		readerDoc.getMap<number>('m').set('mutation', 999);
		readerDoc.getMap<number>('m').set('mutation2', 1000);

		expect(countRows(filePath)).toBe(baselineRows);

		readerDoc.destroy();
		await reader.whenDisposed;
	});
});
