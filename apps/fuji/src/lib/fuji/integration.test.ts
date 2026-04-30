/**
 * Cross-process handoff: daemon writes, script reads.
 *
 * Boots the daemon-side factory in-process, mutates `tables.entries`, lets
 * persistence flush via `ydoc.destroy() + whenDisposed`, then opens the
 * script-side factory against the same `absDir`. The assertion is that
 * the script's `whenReady` warm-replays the daemon's persistence file and
 * the rows show up under `tables.entries.getAllValid()`.
 *
 * Pins the on-disk contract Phase 1 leans on: a sole-writer daemon plus
 * many readonly script peers, sharing a SQLite WAL persistence file. If
 * `persistencePath` resolution drifts, the WAL pragma stops carrying, or
 * the readonly replay diverges from the writer format, this test breaks.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { DateTimeString, generateId } from '@epicenter/workspace';
import { openFuji as openFujiDaemon } from './daemon.js';
import { openFuji as openFujiScript } from './script.js';
import { restoreWebSocket, stubWebSocket } from './ws-stub.js';

let workdir: string;

beforeEach(() => {
	workdir = mkdtempSync(join(tmpdir(), 'fuji-integration-'));
	stubWebSocket();
});

afterEach(() => {
	restoreWebSocket();
	rmSync(workdir, { recursive: true, force: true });
});

describe('daemon -> script handoff via persistence file', () => {
	test('script warm-hydrates entries the daemon wrote', async () => {
		// 1. Daemon owns the persistence file: write a few entries through it.
		const daemon = openFujiDaemon({ getToken: () => 'fake-token', absDir: workdir });
		await daemon.whenReady;

		const now = DateTimeString.now();
		const seedRows = [
			{ id: generateId(), title: 'first' },
			{ id: generateId(), title: 'second' },
			{ id: generateId(), title: 'third' },
		];
		daemon.batch(() => {
			for (const { id, title } of seedRows) {
				daemon.tables.entries.set({
					id,
					title,
					subtitle: '',
					type: [],
					tags: [],
					pinned: false,
					rating: 0,
					deletedAt: undefined,
					date: now,
					createdAt: now,
					updatedAt: now,
					_v: 2 as const,
				});
			}
		});

		// Force a flush + close so the readonly reader sees a stable file.
		// `whenDisposed` resolves after the final compaction + db.close().
		daemon.ydoc.destroy();
		await daemon.persistence.whenDisposed;

		// 2. Script opens the same absDir and replays the persistence file.
		const script = openFujiScript({
			getToken: () => 'fake-token',
			absDir: workdir,
		});
		try {
			await script.whenReady;
			const titles = script.tables.entries
				.getAllValid()
				.map((row) => row.title)
				.sort();
			expect(titles).toEqual(['first', 'second', 'third']);
		} finally {
			script.ydoc.destroy();
			await script.persistence.whenDisposed;
		}
	});
});
