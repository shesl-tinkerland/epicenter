/**
 * Unit tests for `connectDaemon`. We don't bind a real daemon; pinging a
 * non-existent socket is enough to exercise the failure path. The success
 * path is covered indirectly by `remote.test.ts` (which stubs the client
 * directly) and end-to-end by the daemon test suite.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { DaemonError } from '../daemon/client.js';
import type { ProjectDir } from '../shared/types.js';
import { connectDaemon } from './connect-daemon.js';

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'connect-daemon-'));
	writeFileSync(join(root, 'epicenter.config.ts'), '');
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe('connectDaemon', () => {
	test('throws DaemonError.Required when no daemon is listening', async () => {
		let caught: unknown;
		try {
			await connectDaemon({ id: 'demo', projectDir: root as ProjectDir });
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeDefined();
		const e = caught as Extract<DaemonError, { name: 'Required' }>;
		expect(e.name).toBe('Required');
		expect(e.projectDir).toBe(root);
		expect(e.id).toBe('demo');
	});
});
