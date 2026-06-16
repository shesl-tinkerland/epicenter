/**
 * Unit tests for `connectDaemonActions`. We don't bind a real daemon; pinging a
 * non-existent socket is enough to exercise the failure path. The success
 * path is covered indirectly by `daemon-actions.test.ts` (which stubs the client
 * directly) and end-to-end by the daemon test suite.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { DaemonError } from '../daemon/client.js';
import type { EpicenterRoot } from '../shared/types.js';
import { connectDaemonActions } from './connect-daemon-actions.js';

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'connect-daemon-'));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe('connectDaemonActions', () => {
	test('throws DaemonError.Required when no daemon is listening', async () => {
		let caught: unknown;
		try {
			await connectDaemonActions({
				epicenterRoot: root as EpicenterRoot,
			});
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeDefined();
		const e = caught as Extract<DaemonError, { name: 'Required' }>;
		expect(e.name).toBe('Required');
		expect(e.epicenterRoot).toBe(root);
	});
});
