/**
 * Tests for the script-side Fuji factory.
 *
 * Coverage: missing-file fall-through. The `MissingFile` swallow inside
 * `whenReady` is non-obvious behavior worth pinning. Everything else
 * (clientID derivation, attachment wiring, replay correctness) is either
 * enforced by TypeScript or covered end-to-end by `integration.test.ts`.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { openFuji } from './script.js';
import { restoreWebSocket, stubWebSocket } from './ws-stub.js';

let workdir: string;

beforeEach(() => {
	workdir = mkdtempSync(join(tmpdir(), 'fuji-script-'));
	stubWebSocket();
});

afterEach(() => {
	restoreWebSocket();
	rmSync(workdir, { recursive: true, force: true });
});

describe('openFuji (script)', () => {
	test('handles missing persistence file silently', async () => {
		const handle = openFuji({
			getToken: () => 'fake-token',
			absDir: workdir,
		});
		try {
			// `whenReady` swallows MissingFile and resolves; no entries because
			// no daemon has written here. Cloud sync would populate it later.
			await handle.whenReady;
			expect(handle.tables.entries.getAllValid().length).toBe(0);
		} finally {
			handle.ydoc.destroy();
		}
	});
});
