/**
 * Tests for `openProject`, the single daemon entry point.
 *
 * `openProject` imports `epicenter.config.ts` and opens every mount it
 * declares, so these tests drive it through real config files on disk:
 * - a missing config returns a structured `ProjectConfigNotFound` Result
 *   (not a throw), so the host surfaces it like any other startup error
 * - a valid config opens every declared mount in parallel
 * - an empty config opens nothing
 * - if any sibling `open(ctx)` throws, the successfully opened runtimes are
 *   asyncDispose'd before the structured error propagates
 * - invalid mount names fail before any mount opens
 * - a signed-out auth refuses before any mount opens
 *
 * Config-shape validation (single -> array, malformed export, syntax errors)
 * is pinned separately in `config/load-project-config.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { asOwnerId } from '@epicenter/identity';
import { expectErr, expectOk } from 'wellcrafted/testing';

import type { WorkspaceAuthClient } from './auth-client.js';
import { openProject } from './open-project.js';

let projectDir: string;

beforeEach(() => {
	projectDir = mkdtempSync(join(tmpdir(), 'open-project-'));
});

afterEach(() => {
	rmSync(projectDir, { recursive: true, force: true });
});

function writeConfig(source: string): void {
	writeFileSync(join(projectDir, 'epicenter.config.ts'), source);
}

function stubAuthClient(): WorkspaceAuthClient {
	return {
		state: {
			status: 'signed-in',
			ownerId: asOwnerId('test-user'),
			keyring: [] as never,
		},
		openWebSocket: () => Promise.resolve({} as WebSocket),
		fetch: () => Promise.resolve(new Response()),
		onStateChange: () => () => {},
	};
}

/** A mount literal whose runtime disposes cleanly, written into a config. */
const RUNTIME = '{ collaboration: {}, async [Symbol.asyncDispose]() {} }';

describe('openProject', () => {
	test('returns a structured not-found error instead of throwing', async () => {
		const result = await openProject({ projectDir, auth: stubAuthClient() });
		const error = expectErr(result);
		expect(error).toMatchObject({
			name: 'ProjectConfigNotFound',
			projectConfigPath: join(projectDir, 'epicenter.config.ts'),
		});
	});

	test('imports the config and opens every declared mount', async () => {
		writeConfig(
			`export default [
				{ name: 'alpha', open: () => (${RUNTIME}) },
				{ name: 'beta', open: () => (${RUNTIME}) },
			];\n`,
		);

		const result = await openProject({ projectDir, auth: stubAuthClient() });
		const mounts = expectOk(result);
		expect(
			mounts
				.map((entry) => entry.mount)
				.slice()
				.sort(),
		).toEqual(['alpha', 'beta']);
	});

	test('opens nothing for an empty config', async () => {
		writeConfig('export default [];\n');

		const result = await openProject({ projectDir, auth: stubAuthClient() });
		expect(expectOk(result)).toEqual([]);
	});

	test('disposes opened runtimes when a sibling open throws', async () => {
		writeConfig(
			`import { writeFileSync } from 'node:fs';
			import { join } from 'node:path';
			const marker = join(import.meta.dirname, 'good.disposed');
			export default [
				{
					name: 'good',
					open: () => ({
						collaboration: {},
						async [Symbol.asyncDispose]() {
							await Bun.sleep(10);
							writeFileSync(marker, 'disposed');
						},
					}),
				},
				{ name: 'bad', open() { throw new Error('boom'); } },
			];\n`,
		);

		const result = await openProject({ projectDir, auth: stubAuthClient() });
		const error = expectErr(result);
		expect(error).toMatchObject({ name: 'MountOpenFailed', mount: 'bad' });
		expect(await Bun.file(join(projectDir, 'good.disposed')).exists()).toBe(
			true,
		);
	});

	test('rejects invalid mount names before opening any mount', async () => {
		writeConfig(
			`import { writeFileSync } from 'node:fs';
			import { join } from 'node:path';
			export default [
				{
					name: '__proto__',
					open: () => {
						writeFileSync(join(import.meta.dirname, 'opened'), 'opened');
						return ${RUNTIME};
					},
				},
			];\n`,
		);

		const result = await openProject({ projectDir, auth: stubAuthClient() });
		expect(expectErr(result)).toMatchObject({
			name: 'MountRejected',
			mount: '__proto__',
			reason: 'invalid',
		});
		expect(await Bun.file(join(projectDir, 'opened')).exists()).toBe(false);
	});

	test('refuses startup when machine auth is signed out', async () => {
		writeConfig(
			`export default [{ name: 'alpha', open() { throw new Error('must not open'); } }];\n`,
		);

		const result = await openProject({
			projectDir,
			auth: { state: { status: 'signed-out' } } as WorkspaceAuthClient,
		});
		expect(expectErr(result).name).toBe('WorkspaceAuthSignedOut');
	});
});
