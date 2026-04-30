/**
 * Tests for the script-side Fuji factory.
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
import { openFuji } from './script.js';

let workdir: string;

beforeEach(() => {
	workdir = mkdtempSync(join(tmpdir(), 'fuji-script-'));
});

afterEach(() => {
	rmSync(workdir, { recursive: true, force: true });
});

describe('openFuji (script)', () => {
	test('handles missing persistence file silently', async () => {
		// No daemon has written to `workdir`; the readonly persistence rejects
		// with `MissingFile`, the factory swallows it, hydrate resolves to
		// empty. The handle's `tables.entries` is empty until cloud sync
		// would (in real use) populate it.
		await using handle = await openFuji({
			getToken: () => 'fake-token',
			absDir: workdir,
			webSocketImpl: NoopWebSocket as unknown as typeof WebSocket,
		});
		expect(handle.tables.entries.getAllValid().length).toBe(0);
	});
});
