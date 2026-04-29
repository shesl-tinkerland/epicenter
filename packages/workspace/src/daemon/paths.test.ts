import { afterEach, describe, expect, test } from 'bun:test';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { dirHash, runtimeDir, socketPathFor } from './paths.js';

describe('daemon/paths', () => {
	const originalXdg = process.env.XDG_RUNTIME_DIR;

	afterEach(() => {
		if (originalXdg === undefined) {
			delete process.env.XDG_RUNTIME_DIR;
		} else {
			process.env.XDG_RUNTIME_DIR = originalXdg;
		}
	});

	test('dirHash is deterministic for the same absolute path', () => {
		const abs = realpathSync(tmpdir());
		expect(dirHash(abs)).toBe(dirHash(abs));
	});

	test('dirHash of a relative path equals the hash of its realpath', () => {
		// `tmpdir()` may resolve through a symlink (e.g. /tmp → /private/tmp on
		// macOS); dirHash should normalize via realpathSync so equivalent inputs
		// hash identically.
		const symlinked = tmpdir();
		const real = realpathSync(symlinked);
		expect(dirHash(symlinked)).toBe(dirHash(real));
	});

	test('socketPathFor stays comfortably under macOS 104-char limit', () => {
		// Worst-case: a long $EPICENTER_HOME with no XDG override.
		delete process.env.XDG_RUNTIME_DIR;
		const dir = realpathSync(tmpdir());
		expect(socketPathFor(dir).length).toBeLessThanOrEqual(100);
	});

	test('runtimeDir honors XDG_RUNTIME_DIR when set, falls back to home/run when unset', () => {
		process.env.XDG_RUNTIME_DIR = '/tmp/fake-xdg';
		expect(runtimeDir()).toBe(join('/tmp/fake-xdg', 'epicenter'));

		delete process.env.XDG_RUNTIME_DIR;
		expect(runtimeDir().endsWith('/run')).toBe(true);
	});
});
