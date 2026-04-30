import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { resolveProjectArg, resolveProjectDir } from './common-options.js';

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

function tempProject() {
	const root = mkdtempSync(join(tmpdir(), 'ep-cli-project-'));
	roots.push(root);
	writeFileSync(join(root, 'epicenter.config.ts'), 'export default {};\n');
	const nested = join(root, 'nested', 'child');
	mkdirSync(nested, { recursive: true });
	return { root, nested };
}

describe('resolveProjectDir', () => {
	test('discovers the nearest Epicenter project from a start directory', () => {
		const { root, nested } = tempProject();

		expect(resolveProjectDir(nested)).toBe(root);
	});

	test('falls back to an absolute start path when discovery misses', () => {
		const root = mkdtempSync(join(tmpdir(), 'ep-cli-no-project-'));
		roots.push(root);

		expect(resolveProjectDir(root)).toBe(resolve(root));
	});
});

describe('resolveProjectArg', () => {
	test('resolves the parsed project flag before daemon lookup', () => {
		const { root, nested } = tempProject();

		expect(resolveProjectArg(nested)).toBe(root);
	});
});
