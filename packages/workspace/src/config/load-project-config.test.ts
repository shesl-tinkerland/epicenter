/**
 * Project config loading tests.
 *
 * Verifies that `epicenter.config.ts` is discovered, imported, and runtime
 * validated before daemon startup consumes the mount.
 *
 * Invariant under test: `loadProjectConfig` is total. Every failure mode
 * (missing file, import/syntax error, wrong-shaped export) comes back as a
 * specific `ProjectConfigError` variant in the error channel; it never throws.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadProjectConfig } from './load-project-config.js';

let epicenterRoot: string;

beforeEach(() => {
	epicenterRoot = mkdtempSync(join(tmpdir(), 'load-project-config-'));
});

afterEach(() => {
	rmSync(epicenterRoot, { recursive: true, force: true });
});

function writeConfig(source: string): void {
	writeFileSync(join(epicenterRoot, 'epicenter.config.ts'), source);
}

describe('loadProjectConfig', () => {
	test('returns a typed not-found error when the config is missing', async () => {
		const { data, error } = await loadProjectConfig(epicenterRoot);
		expect(data).toBeNull();
		if (error === null) throw new Error('Expected ProjectConfigNotFound');
		expect(error).toMatchObject({
			name: 'ProjectConfigNotFound',
			projectConfigPath: join(epicenterRoot, 'epicenter.config.ts'),
		});
	});

	test('passes through a single Mount default export', async () => {
		writeConfig("export default { name: 'demo', open() {} };\n");

		const { data, error } = await loadProjectConfig(epicenterRoot);
		if (error !== null) throw new Error(error.message);
		expect(data.name).toBe('demo');
	});

	test('rejects a non-Mount default export', async () => {
		writeConfig('export default { notAMount: true };\n');

		const { error } = await loadProjectConfig(epicenterRoot);
		expect(error).toMatchObject({
			name: 'ProjectConfigInvalid',
			projectConfigPath: join(epicenterRoot, 'epicenter.config.ts'),
		});
	});

	test('rejects an array default export', async () => {
		writeConfig("export default [{ name: 'demo', open() {} }];\n");

		const { error } = await loadProjectConfig(epicenterRoot);
		expect(error).toMatchObject({
			name: 'ProjectConfigInvalid',
			detail:
				'the default export is an array; export the mount directly, for example `export default fuji()`',
		});
	});

	test('rejects a config with no default export', async () => {
		writeConfig('export const config = {};\n');

		const { error } = await loadProjectConfig(epicenterRoot);
		expect(error?.name).toBe('ProjectConfigInvalid');
	});

	test('reports a structured import error for bad syntax', async () => {
		writeConfig('export default {;\n');

		const { error } = await loadProjectConfig(epicenterRoot);
		expect(error).toMatchObject({
			name: 'ProjectConfigImportFailed',
			projectConfigPath: join(epicenterRoot, 'epicenter.config.ts'),
		});
	});
});
