/**
 * Cross-process handoff: daemon writes, script reads.
 *
 * Boots the daemon-side factory in-process, mutates `tables.files`, lets
 * persistence flush via `[Symbol.dispose]()`, then opens the script-side
 * factory against the same `projectDir`. The script's warm hydrate replays the
 * daemon's persistence file and the rows show up under
 * `tables.files.getAllValid()`.
 *
 * Pins the on-disk contract: a sole-writer daemon plus many readonly script
 * peers, sharing a SQLite WAL persistence file.
 */

import { rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { NoopWebSocket, type ProjectDir } from '@epicenter/workspace';
import { mintTestProjectDir } from '@epicenter/workspace/test-utils';
import { type FileId, generateFileId } from '@epicenter/filesystem';
import { openOpensidian as openOpensidianDaemon } from './daemon.js';
import { openOpensidian as openOpensidianScript } from './script.js';

let workdir: ProjectDir;

beforeEach(() => {
	workdir = mintTestProjectDir('opensidian-integration-');
});

afterEach(() => {
	rmSync(workdir, { recursive: true, force: true });
});


describe('daemon -> script handoff via persistence file', () => {
	test('script warm-hydrates files the daemon wrote', async () => {
		// 1. Daemon owns the persistence file inside this block: write a few
		// files, then let the block-scoped `using` dispose at `}` so the
		// writer commits and closes before the reader opens.
		{
			using daemon = openOpensidianDaemon({
				getToken: async () => 'fake-token',
				device: {
					id: 'test-daemon',
					name: 'Opensidian Daemon (test)',
					platform: 'linux',
				},
				projectDir: workdir,
				webSocketImpl: NoopWebSocket,
			});

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
		}

		// 2. Script opens the same projectDir and replays the persistence file.
		using script = openOpensidianScript({
			getToken: async () => 'fake-token',
			projectDir: workdir,
			webSocketImpl: NoopWebSocket,
		});
		const names = script.tables.files
			.getAllValid()
			.map((row) => row.name)
			.sort();
		expect(names).toEqual(['first.md', 'second.md', 'third.md']);
	});
});
