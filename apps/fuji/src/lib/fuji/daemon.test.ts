/**
 * Tests for the daemon-side Fuji factory.
 *
 * Coverage:
 *  - Construction wires persistence + sync + sqlite materializer +
 *    markdown materializer without throwing.
 *  - `whenReady` resolves.
 *  - Tearing down the handle disposes attachments without errors.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { openFuji } from './daemon.js';
import { restoreWebSocket, stubWebSocket } from './ws-stub.js';

let workdir: string;

beforeEach(() => {
	workdir = mkdtempSync(join(tmpdir(), 'fuji-daemon-'));
	stubWebSocket();
});

afterEach(() => {
	restoreWebSocket();
	rmSync(workdir, { recursive: true, force: true });
});

describe('openFuji (daemon)', () => {
	test('constructs all attachments and resolves whenReady', async () => {
		const handle = openFuji({
			authToken: 'fake-token',
			absDir: workdir,
		});
		try {
			expect(handle.persistence).toBeDefined();
			expect(handle.sync).toBeDefined();
			expect(handle.sqlite).toBeDefined();
			expect(handle.markdown).toBeDefined();
			await handle.whenReady;
		} finally {
			handle.ydoc.destroy();
			await Promise.all([
				handle.persistence.whenDisposed,
				handle.sync.whenDisposed,
			]);
		}
	});

	test('disposing the handle does not throw', async () => {
		const handle = openFuji({
			authToken: 'fake-token',
			absDir: workdir,
		});
		await handle.whenReady;
		handle.ydoc.destroy();
		// All four attachments listen on the doc's destroy event; the wait
		// surface here is the persistence + sync's whenDisposed (the
		// materializers don't expose one, but they observe the same event
		// and clean up synchronously).
		await Promise.all([
			handle.persistence.whenDisposed,
			handle.sync.whenDisposed,
		]);
	});
});
