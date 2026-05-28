/**
 * Project config loading tests.
 *
 * Verifies that `epicenter.config.ts` is discovered, imported, and runtime
 * validated before daemon startup consumes the mounts.
 *
 * Key behaviors:
 * - missing configs return a typed not-found error
 * - a Mount default export normalizes to a single-element array
 * - a Mount[] default export passes through
 * - non-Mount values are rejected with the config path in the failure
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadProjectConfig } from './load-project-config.js';

let projectDir: string;

beforeEach(() => {
	projectDir = mkdtempSync(join(tmpdir(), 'load-project-config-'));
});

afterEach(() => {
	rmSync(projectDir, { recursive: true, force: true });
});

function writeConfig(source: string): void {
	writeFileSync(join(projectDir, 'epicenter.config.ts'), source);
}

describe('loadProjectConfig', () => {
	test('returns a typed not-found error when the config is missing', async () => {
		const { data, error } = await loadProjectConfig(projectDir);
		expect(data).toBeNull();
		if (error === null) throw new Error('Expected ProjectConfigNotFound');
		expect(error).toMatchObject({
			name: 'ProjectConfigNotFound',
			projectConfigPath: join(projectDir, 'epicenter.config.ts'),
		});
	});

	test('normalizes a single Mount default export into a one-element array', async () => {
		writeConfig("export default { name: 'demo', open() {} };\n");

		const { data, error } = await loadProjectConfig(projectDir);
		if (error !== null) throw new Error(error.message);
		expect(data).toHaveLength(1);
		expect(data[0]?.name).toBe('demo');
		expect(data[0]?.open).toBeFunction();
	});

	test('passes through a Mount[] default export', async () => {
		writeConfig(
			"export default [{ name: 'a', open() {} }, { name: 'b', open() {} }];\n",
		);

		const { data, error } = await loadProjectConfig(projectDir);
		if (error !== null) throw new Error(error.message);
		expect(data.map((mount) => mount.name)).toEqual(['a', 'b']);
	});

	test('returns an empty array for an empty Mount[] default export', async () => {
		writeConfig('export default [];\n');

		const { data, error } = await loadProjectConfig(projectDir);
		if (error !== null) throw new Error(error.message);
		expect(data).toEqual([]);
	});

	test('throws with the config path when the default export is neither a Mount nor a Mount[]', async () => {
		writeConfig('export default { notAMount: true };\n');

		await expect(loadProjectConfig(projectDir)).rejects.toThrow(
			`loadProjectConfig: ${join(projectDir, 'epicenter.config.ts')} must default-export a Mount or Mount[]`,
		);
	});

	test('throws when the Mount[] default export contains a non-Mount value', async () => {
		writeConfig("export default [{ name: 'demo', open() {} }, { open: 1 }];\n");

		await expect(loadProjectConfig(projectDir)).rejects.toThrow(
			`loadProjectConfig: ${join(projectDir, 'epicenter.config.ts')} default-exports an array containing a non-Mount value.`,
		);
	});

	test('throws when a Mount lacks open()', async () => {
		writeConfig("export default { name: 'demo' };\n");

		await expect(loadProjectConfig(projectDir)).rejects.toThrow(
			`loadProjectConfig: ${join(projectDir, 'epicenter.config.ts')} must default-export a Mount or Mount[]`,
		);
	});

	test('throws when a Mount lacks a string name', async () => {
		writeConfig('export default { open() {} };\n');

		await expect(loadProjectConfig(projectDir)).rejects.toThrow(
			`loadProjectConfig: ${join(projectDir, 'epicenter.config.ts')} must default-export a Mount or Mount[]`,
		);
	});

	test('throws with the config path when the default export is missing', async () => {
		writeConfig('export const config = {};\n');

		await expect(loadProjectConfig(projectDir)).rejects.toThrow(
			`loadProjectConfig: ${join(projectDir, 'epicenter.config.ts')} must default-export`,
		);
	});

	test('throws with the config path when the config has bad syntax', async () => {
		writeConfig('export default {;\n');

		await expect(loadProjectConfig(projectDir)).rejects.toThrow(
			`loadProjectConfig: failed to load ${join(projectDir, 'epicenter.config.ts')}`,
		);
	});
});
