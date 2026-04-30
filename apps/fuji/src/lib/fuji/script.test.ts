/**
 * Tests for the script-side Fuji factory.
 *
 * Coverage:
 *  - clientID is the stable hash of `Bun.main`.
 *  - missing persistence file: factory still resolves, doc is empty.
 *  - present persistence file: rows replay onto the doc.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
	attachSqlitePersistence,
	hashClientId,
	persistencePath,
} from '@epicenter/workspace';
import * as Y from 'yjs';
import { openFuji } from './script.js';
import { restoreWebSocket, stubWebSocket } from './ws-stub.js';

let workdir: string;

beforeEach(() => {
	workdir = mkdtempSync(join(tmpdir(), 'fuji-script-'));
	stubWebSocket();
});

afterEach(() => {
	restoreWebSocket();
	rmSync(workdir, { recursive: true, force: true });
});

describe('openFuji (script)', () => {
	test('uses hashClientId(Bun.main) as the Y.Doc clientID', () => {
		const handle = openFuji({
			authToken: 'fake-token',
			absDir: workdir,
		});
		try {
			// clientID is set during sync construction; no `whenReady` needed.
			expect(handle.ydoc.clientID).toBe(hashClientId(Bun.main));
		} finally {
			handle.ydoc.destroy();
		}
	});

	test('handles missing persistence file silently', async () => {
		const handle = openFuji({
			authToken: 'fake-token',
			absDir: workdir,
		});
		try {
			// `whenReady` swallows MissingFile and resolves; no entries because
			// no daemon has written here. Cloud sync would populate it later.
			await handle.whenReady;
			expect(handle.tables.entries.getAllValid().length).toBe(0);
		} finally {
			handle.ydoc.destroy();
		}
	});

	test('replays a pre-populated persistence file into the doc', async () => {
		// Seed a persistence file using the writer so the script-mode factory
		// has something to hydrate from. Writer + reader share the same on-disk
		// format; this test pins that contract end-to-end through the factory.
		const guid = 'epicenter.fuji';
		const filePath = persistencePath(workdir, guid);

		const writerDoc = new Y.Doc({ guid, gc: false });
		const writer = attachSqlitePersistence(writerDoc, { filePath });
		await writer.whenLoaded;
		const map = writerDoc.getMap<string>('m');
		writerDoc.transact(() => {
			map.set('a', 'one');
			map.set('b', 'two');
		});
		writerDoc.destroy();
		await writer.whenDisposed;

		// Sanity: writer file has rows.
		const probe = new Database(filePath, { readonly: true });
		const count = probe.query('SELECT COUNT(*) as c FROM updates').get() as {
			c: number;
		};
		probe.close();
		expect(count.c).toBeGreaterThan(0);

		const handle = openFuji({
			authToken: 'fake-token',
			absDir: workdir,
		});
		try {
			await handle.whenReady;
			const m = handle.ydoc.getMap<string>('m');
			expect(m.get('a')).toBe('one');
			expect(m.get('b')).toBe('two');
		} finally {
			handle.ydoc.destroy();
		}
	});
});
