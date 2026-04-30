/**
 * Cross-process handoff: daemon writes, script reads.
 *
 * Boots the daemon-side factory in-process, mutates `tables.files`, lets
 * persistence flush via `[Symbol.dispose]()`, then opens the script-side
 * factory against the same `absDir`. The script's warm hydrate replays the
 * daemon's persistence file and the rows show up under
 * `tables.files.getAllValid()`.
 *
 * Pins the on-disk contract: a sole-writer daemon plus many readonly script
 * peers, sharing a SQLite WAL persistence file.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { NoopWebSocket } from '@epicenter/workspace';
import { type FileId, generateFileId } from '@epicenter/filesystem';
import { openOpensidian as openOpensidianDaemon } from './daemon.js';
import { openOpensidian as openOpensidianScript } from './script.js';

let workdir: string;

beforeEach(() => {
	workdir = mkdtempSync(join(tmpdir(), 'opensidian-integration-'));
});

afterEach(() => {
	rmSync(workdir, { recursive: true, force: true });
});

const wsImpl = NoopWebSocket as unknown as typeof WebSocket;

describe('daemon -> script handoff via persistence file', () => {
	test('script warm-hydrates files the daemon wrote', async () => {
		// 1. Daemon owns the persistence file: write a few files through it.
		const daemon = openOpensidianDaemon({
			getToken: () => 'fake-token',
			absDir: workdir,
			webSocketImpl: wsImpl,
		});
		await daemon.persistence.whenLoaded;

		const now = Date.now();
		const seed: { id: FileId; name: string }[] = [
			{ id: generateFileId(), name: 'first.md' },
			{ id: generateFileId(), name: 'second.md' },
			{ id: generateFileId(), name: 'third.md' },
		];
		daemon.batch(() => {
			for (const { id, name } of seed) {
				daemon.tables.files.set({
					id,
					name,
					parentId: null,
					type: 'file',
					size: 0,
					createdAt: now,
					updatedAt: now,
					trashedAt: null,
					_v: 1 as const,
				});
			}
		});

		// Force the writer to commit + close before the reader opens.
		daemon[Symbol.dispose]();

		// 2. Script opens the same absDir and replays the persistence file.
		await using script = await openOpensidianScript({
			getToken: () => 'fake-token',
			absDir: workdir,
			webSocketImpl: wsImpl,
		});
		const names = script.tables.files
			.getAllValid()
			.map((row) => row.name)
			.sort();
		expect(names).toEqual(['first.md', 'second.md', 'third.md']);
	});
});
