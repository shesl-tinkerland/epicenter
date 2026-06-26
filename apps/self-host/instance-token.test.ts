/**
 * First-boot instance-token unit tests.
 *
 * These pin the three behaviors a self-hoster relies on across reboots: an
 * env-provided token short-circuits without ever touching disk; a freshly minted
 * token is persisted and reused verbatim on the next boot (so a restart never
 * invalidates the operator's pasted credential); and the minted file is 0600.
 */

import { afterAll, expect, test } from 'bun:test';
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadOrMintInstanceToken } from './instance-token.js';

const tempDirs: string[] = [];

/** A fresh, isolated data dir per test so mint/reuse cases never collide. */
function freshDataDir(): string {
	const dir = mkdtempSync(join(tmpdir(), 'instance-token-'));
	tempDirs.push(dir);
	return dir;
}

afterAll(() => {
	for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

test('mints a token on first boot and writes it to <dataDir>/instance-token', () => {
	const dataDir = freshDataDir();
	const result = loadOrMintInstanceToken({ dataDir });

	expect(result.minted).toBe(true);
	expect(result.path).toBe(join(dataDir, 'instance-token'));
	expect(result.token).toMatch(/^[A-Za-z0-9_-]+$/); // base64url, no padding
	expect(readFileSync(result.path, 'utf8')).toBe(result.token);
});

test('reuses the same token on the next boot instead of re-minting', () => {
	const dataDir = freshDataDir();
	const first = loadOrMintInstanceToken({ dataDir });
	const second = loadOrMintInstanceToken({ dataDir });

	expect(first.minted).toBe(true);
	expect(second.minted).toBe(false);
	expect(second.token).toBe(first.token);
});

test('env token wins and is never written to disk', () => {
	const dataDir = freshDataDir();
	const result = loadOrMintInstanceToken({
		dataDir,
		envToken: 'operator-supplied-token',
	});

	expect(result).toEqual({
		token: 'operator-supplied-token',
		minted: false,
		path: join(dataDir, 'instance-token'),
	});
	expect(existsSync(result.path)).toBe(false);
});

test('persists the minted token with 0600 permissions', () => {
	const dataDir = freshDataDir();
	const { path } = loadOrMintInstanceToken({ dataDir });

	expect(statSync(path).mode & 0o777).toBe(0o600);
});
