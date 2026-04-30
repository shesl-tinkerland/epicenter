/**
 * Cross-process handoff: daemon writes, script reads.
 *
 * Boots the daemon-side factory in-process, mutates `tables.entries`, lets
 * persistence flush via `[Symbol.dispose]()`, then opens the script-side
 * factory against the same `absDir`. The script's warm hydrate replays the
 * daemon's persistence file and the rows show up under
 * `tables.entries.getAllValid()`.
 *
 * Pins the on-disk contract Phase 1 leans on: a sole-writer daemon plus
 * many readonly script peers, sharing a SQLite WAL persistence file. If
 * `yjsPath` resolution drifts, the WAL pragma stops carrying, or
 * the readonly replay diverges from the writer format, this test breaks.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
	DateTimeString,
	generateId,
	NoopWebSocket,
	type ProjectDir,
} from '@epicenter/workspace';
import { openFuji as openFujiDaemon } from './daemon.js';
import { openFuji as openFujiScript } from './script.js';

let workdir: ProjectDir;

beforeEach(() => {
	workdir = mkdtempSync(join(tmpdir(), 'fuji-integration-')) as ProjectDir;
});

afterEach(() => {
	rmSync(workdir, { recursive: true, force: true });
});


describe('daemon -> script handoff via persistence file', () => {
	test('script warm-hydrates entries the daemon wrote', async () => {
		// 1. Daemon owns the persistence file inside this block: the writer
		// must close (via `}`) before the reader opens so the readonly
		// attachment sees the file on stable WAL pages.
		{
			using daemon = openFujiDaemon({
				getToken: () => 'fake-token',
				absDir: workdir,
				webSocketImpl: NoopWebSocket,
			});
			await daemon.persistence.whenLoaded;

			const now = DateTimeString.now();
			const seed = [
				{ id: generateId(), title: 'first' },
				{ id: generateId(), title: 'second' },
				{ id: generateId(), title: 'third' },
			];
			daemon.batch(() => {
				for (const { id, title } of seed) {
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
		}

		// 2. Script opens the same absDir and replays the persistence file.
		using script = await openFujiScript({
			getToken: () => 'fake-token',
			absDir: workdir,
			webSocketImpl: NoopWebSocket,
		});
		const titles = script.tables.entries
			.getAllValid()
			.map((row) => row.title)
			.sort();
		expect(titles).toEqual(['first', 'second', 'third']);
	});
});
