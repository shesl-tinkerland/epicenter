/**
 * Cross-process handoff: daemon writes, script reads.
 *
 * Pins the on-disk contract: a sole-writer daemon plus many readonly script
 * peers, sharing a SQLite WAL persistence file.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { NoopWebSocket, type ProjectDir } from '@epicenter/workspace';
import {
	type ConversationId,
	generateConversationId,
} from '../workspace/definition.js';
import { openZhongwen as openZhongwenDaemon } from './daemon.js';
import { openZhongwen as openZhongwenScript } from './script.js';

let workdir: ProjectDir;

beforeEach(() => {
	workdir = mkdtempSync(join(tmpdir(), 'zhongwen-integration-')) as ProjectDir;
});

afterEach(() => {
	rmSync(workdir, { recursive: true, force: true });
});


describe('daemon -> script handoff via persistence file', () => {
	test('script warm-hydrates conversations the daemon wrote', async () => {
		// Daemon owns the persistence file inside this block: the writer must
		// close (via `}`) before the reader opens so the readonly attachment
		// sees the file on stable WAL pages.
		{
			using daemon = openZhongwenDaemon({
				getToken: () => 'fake-token',
				absDir: workdir,
				webSocketImpl: NoopWebSocket,
			});
			await daemon.persistence.whenLoaded;

			const now = Date.now();
			const seed: { id: ConversationId; title: string }[] = [
				{ id: generateConversationId(), title: 'first' },
				{ id: generateConversationId(), title: 'second' },
				{ id: generateConversationId(), title: 'third' },
			];
			daemon.batch(() => {
				for (const { id, title } of seed) {
					daemon.tables.conversations.set({
						id,
						title,
						provider: 'openai',
						model: 'gpt-4',
						createdAt: now,
						updatedAt: now,
						_v: 1 as const,
					});
				}
			});
		}

		using script = await openZhongwenScript({
			getToken: () => 'fake-token',
			absDir: workdir,
			webSocketImpl: NoopWebSocket,
		});
		const titles = script.tables.conversations
			.getAllValid()
			.map((row) => row.title)
			.sort();
		expect(titles).toEqual(['first', 'second', 'third']);
	});
});
