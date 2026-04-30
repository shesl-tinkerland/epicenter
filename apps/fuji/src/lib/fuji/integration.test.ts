/**
 * Cross-process handoff: daemon writes, script reads.
 *
 * Boots the daemon-side factory in-process, mutates `tables.entries`, lets
 * persistence flush via `[Symbol.dispose]()`, then opens the script-side
 * factory against the same `projectDir`. The script's warm hydrate replays the
 * daemon's persistence file and the rows show up under
 * `tables.entries.getAllValid()`.
 *
 * Pins the on-disk contract Phase 1 leans on: a sole-writer daemon plus
 * many readonly script peers, sharing a SQLite WAL persistence file. If
 * `yjsPath` resolution drifts, the WAL pragma stops carrying, or
 * the readonly replay diverges from the writer format, this test breaks.
 */

import { rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
	DateTimeString,
	generateId,
	NoopWebSocket,
	type ProjectDir,
} from '@epicenter/workspace';
import { mintTestProjectDir } from '@epicenter/workspace/test-utils';
import { openFuji as openFujiDaemon } from './daemon.js';
import { openFuji as openFujiScript } from './script.js';

let workdir: ProjectDir;

beforeEach(() => {
	workdir = mintTestProjectDir('fuji-integration-');
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
				device: {
					id: 'test-daemon',
					name: 'Fuji Daemon (test)',
					platform: 'linux',
				},
				projectDir: workdir,
				webSocketImpl: NoopWebSocket,
			});
			await daemon.whenReady;

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

		// 2. Script opens the same projectDir and replays the persistence file.
		using script = await openFujiScript({
			getToken: () => 'fake-token',
			projectDir: workdir,
			webSocketImpl: NoopWebSocket,
		});
		const titles = script.tables.entries
			.getAllValid()
			.map((row) => row.title)
			.sort();
		expect(titles).toEqual(['first', 'second', 'third']);
	});
});
