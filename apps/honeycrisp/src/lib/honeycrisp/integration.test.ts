/**
 * Cross-process handoff: daemon writes, script reads.
 *
 * Boots the daemon-side factory in-process, mutates `tables.notes`, lets
 * persistence flush via `[Symbol.dispose]()`, then opens the script-side
 * factory against the same `absDir`. Pins the on-disk contract: a
 * sole-writer daemon plus many readonly script peers, sharing a SQLite WAL
 * persistence file.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { DateTimeString, NoopWebSocket } from '@epicenter/workspace';
import { type NoteId } from '../workspace.js';
import { openHoneycrisp as openHoneycrispDaemon } from './daemon.js';
import { openHoneycrisp as openHoneycrispScript } from './script.js';

let workdir: string;

beforeEach(() => {
	workdir = mkdtempSync(join(tmpdir(), 'honeycrisp-integration-'));
});

afterEach(() => {
	rmSync(workdir, { recursive: true, force: true });
});

const wsImpl = NoopWebSocket as unknown as typeof WebSocket;

describe('daemon -> script handoff via persistence file', () => {
	test('script warm-hydrates notes the daemon wrote', async () => {
		const daemon = openHoneycrispDaemon({
			getToken: () => 'fake-token',
			absDir: workdir,
			webSocketImpl: wsImpl,
		});
		await daemon.persistence.whenLoaded;

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

		daemon[Symbol.dispose]();

		using script = await openHoneycrispScript({
			getToken: () => 'fake-token',
			absDir: workdir,
			webSocketImpl: wsImpl,
		});
		const titles = script.tables.notes
			.getAllValid()
			.map((row) => row.title)
			.sort();
		expect(titles).toEqual(['first', 'second', 'third']);
	});
});
