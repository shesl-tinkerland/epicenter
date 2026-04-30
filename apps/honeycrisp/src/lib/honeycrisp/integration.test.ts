/**
 * Cross-process handoff: daemon writes, script reads.
 *
 * Boots the daemon-side factory in-process, mutates `tables.notes`, lets
 * persistence flush via `[Symbol.dispose]()`, then opens the script-side
 * factory against the same `projectDir`. Pins the on-disk contract: a
 * sole-writer daemon plus many readonly script peers, sharing a SQLite WAL
 * persistence file.
 */

import { rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
	DateTimeString,
	NoopWebSocket,
	type ProjectDir,
} from '@epicenter/workspace';
import { mintTestProjectDir } from '@epicenter/workspace/test-utils';
import { type NoteId } from '../workspace.js';
import { openHoneycrisp as openHoneycrispDaemon } from './daemon.js';
import { openHoneycrisp as openHoneycrispScript } from './script.js';

let workdir: ProjectDir;

beforeEach(() => {
	workdir = mintTestProjectDir('honeycrisp-integration-');
});

afterEach(() => {
	rmSync(workdir, { recursive: true, force: true });
});


describe('daemon -> script handoff via persistence file', () => {
	test('script warm-hydrates notes the daemon wrote', async () => {
		// Daemon owns the persistence file inside this block: the writer must
		// close (via `}`) before the reader opens so the readonly attachment
		// sees the file on stable WAL pages.
		{
			using daemon = openHoneycrispDaemon({
				getToken: async () => 'fake-token',
				device: {
					id: 'test-daemon',
					name: 'Honeycrisp Daemon (test)',
					platform: 'linux',
				},
				projectDir: workdir,
				webSocketImpl: NoopWebSocket,
			});

			const now = DateTimeString.now();
			const seed: { id: NoteId; title: string }[] = [
				{ id: 'a' as NoteId, title: 'first' },
				{ id: 'b' as NoteId, title: 'second' },
				{ id: 'c' as NoteId, title: 'third' },
			];
			daemon.batch(() => {
				for (const { id, title } of seed) {
					daemon.tables.notes.set({
						id,
						title,
						preview: '',
						pinned: false,
						createdAt: now,
						updatedAt: now,
						_v: 1 as const,
					});
				}
			});
		}

		using script = openHoneycrispScript({
			getToken: async () => 'fake-token',
			projectDir: workdir,
			webSocketImpl: NoopWebSocket,
		});
		const titles = script.tables.notes
			.getAllValid()
			.map((row) => row.title)
			.sort();
		expect(titles).toEqual(['first', 'second', 'third']);
	});
});
