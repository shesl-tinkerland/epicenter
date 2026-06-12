/**
 * Tests for `epicenter init`: scaffolds the default config into the target
 * directory and leaves an existing config untouched.
 */

import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_PROJECT_CONFIG_SOURCE } from '@epicenter/workspace/node';
import { createCLI } from '../cli.js';

let workDir: string;

beforeEach(() => {
	workDir = mkdtempSync('/tmp/eps-init-');
});

afterEach(() => {
	rmSync(workDir, { recursive: true, force: true });
});

test('init scaffolds the default config', async () => {
	await createCLI().run(['init', workDir]);

	expect(readFileSync(join(workDir, 'epicenter.config.ts'), 'utf8')).toBe(
		DEFAULT_PROJECT_CONFIG_SOURCE,
	);
});

test('init leaves an existing config untouched', async () => {
	const original = 'export default []; // keep me\n';
	writeFileSync(join(workDir, 'epicenter.config.ts'), original);

	await createCLI().run(['init', workDir]);

	expect(readFileSync(join(workDir, 'epicenter.config.ts'), 'utf8')).toBe(
		original,
	);
});
