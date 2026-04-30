/**
 * Tests for the script-side Opensidian factory.
 *
 * Coverage: missing-file fall-through. The `MissingFile` swallow inside the
 * factory is non-obvious behavior worth pinning. Everything else (clientID
 * derivation, attachment wiring, replay correctness) is either enforced by
 * TypeScript or covered end-to-end by `integration.test.ts`.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { NoopWebSocket } from '@epicenter/workspace';
import { openOpensidian } from './script.js';

let workdir: string;

beforeEach(() => {
	workdir = mkdtempSync(join(tmpdir(), 'opensidian-script-'));
});

afterEach(() => {
	rmSync(workdir, { recursive: true, force: true });
});

describe('openOpensidian (script)', () => {
	test('handles missing persistence file silently', async () => {
		await using handle = await openOpensidian({
			getToken: () => 'fake-token',
			absDir: workdir,
			webSocketImpl: NoopWebSocket as unknown as typeof WebSocket,
		});
		expect(handle.tables.files.getAllValid().length).toBe(0);
	});
});
