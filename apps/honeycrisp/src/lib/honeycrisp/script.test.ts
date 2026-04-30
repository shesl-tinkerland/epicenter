/**
 * Tests for the script-side Honeycrisp factory.
 *
 * Coverage: missing-file fall-through. Everything else is enforced by
 * TypeScript or covered by `integration.test.ts`.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { NoopWebSocket } from '@epicenter/workspace';
import { openHoneycrisp } from './script.js';

let workdir: string;

beforeEach(() => {
	workdir = mkdtempSync(join(tmpdir(), 'honeycrisp-script-'));
});

afterEach(() => {
	rmSync(workdir, { recursive: true, force: true });
});

describe('openHoneycrisp (script)', () => {
	test('handles missing persistence file silently', async () => {
		using handle = await openHoneycrisp({
			getToken: () => 'fake-token',
			absDir: workdir,
			webSocketImpl: NoopWebSocket as unknown as typeof WebSocket,
		});
		expect(handle.tables.notes.getAllValid().length).toBe(0);
	});
});
