/**
 * Tests for the script-side Zhongwen factory.
 *
 * Coverage: missing-file fall-through. Everything else is enforced by
 * TypeScript or covered by `integration.test.ts`.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { NoopWebSocket } from '@epicenter/workspace';
import { openZhongwen } from './script.js';

let workdir: string;

beforeEach(() => {
	workdir = mkdtempSync(join(tmpdir(), 'zhongwen-script-'));
});

afterEach(() => {
	rmSync(workdir, { recursive: true, force: true });
});

describe('openZhongwen (script)', () => {
	test('handles missing persistence file silently', async () => {
		using handle = await openZhongwen({
			getToken: () => 'fake-token',
			absDir: workdir,
			webSocketImpl: NoopWebSocket as unknown as typeof WebSocket,
		});
		expect(handle.tables.conversations.getAllValid().length).toBe(0);
	});
});
