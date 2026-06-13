/**
 * Tests for `openProject`, the single daemon entry point.
 *
 * `openProject` imports `epicenter.config.ts` and opens the one mount it
 * declares, so these tests drive it through real config files on disk:
 * - a missing config returns a structured `ProjectConfigNotFound` Result
 *   (not a throw), so the host surfaces it like any other startup error
 * - a valid config opens the declared mount
 * - a mount whose `open(ctx)` throws comes back as a structured `MountOpenFailed`
 * - an invalid mount name fails before the mount opens
 * - a signed-out auth refuses before the mount opens
 *
 * Config-shape validation (array -> single, malformed export, syntax errors)
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

let epicenterRoot: string;

beforeEach(() => {
	epicenterRoot = mkdtempSync(join(tmpdir(), 'open-project-'));
});

afterEach(() => {
	rmSync(epicenterRoot, { recursive: true, force: true });
});

function writeConfig(source: string): void {
	writeFileSync(join(epicenterRoot, 'epicenter.config.ts'), source);
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
		const result = await openProject({ epicenterRoot, auth: stubAuthClient() });
		const error = expectErr(result);
		expect(error).toMatchObject({
			name: 'ProjectConfigNotFound',
			projectConfigPath: join(epicenterRoot, 'epicenter.config.ts'),
		});
	});

	test('imports the config and opens the declared mount', async () => {
		writeConfig(
			`export default { name: 'alpha', open: () => (${RUNTIME}) };\n`,
		);

		const result = await openProject({ epicenterRoot, auth: stubAuthClient() });
		const mount = expectOk(result);
		expect(mount.mount).toBe('alpha');
	});

	test('returns a structured MountOpenFailed when the mount open throws', async () => {
		writeConfig(
			`export default { name: 'bad', open() { throw new Error('boom'); } };\n`,
		);

		const result = await openProject({ epicenterRoot, auth: stubAuthClient() });
		expect(expectErr(result)).toMatchObject({
			name: 'MountOpenFailed',
			mount: 'bad',
		});
	});

	test('surfaces the loader name rejection and never opens the mount', async () => {
		writeConfig(
			`import { writeFileSync } from 'node:fs';
			import { join } from 'node:path';
			export default {
				name: '__proto__',
				open: () => {
					writeFileSync(join(import.meta.dirname, 'opened'), 'opened');
					return ${RUNTIME};
				},
			};\n`,
		);

		const result = await openProject({ epicenterRoot, auth: stubAuthClient() });
		expect(expectErr(result).name).toBe('ProjectConfigInvalid');
		expect(await Bun.file(join(epicenterRoot, 'opened')).exists()).toBe(false);
	});

	test('refuses startup when machine auth is signed out', async () => {
		writeConfig(
			`export default { name: 'alpha', open() { throw new Error('must not open'); } };\n`,
		);

		const result = await openProject({
			epicenterRoot,
			auth: { state: { status: 'signed-out' } } as WorkspaceAuthClient,
		});
		expect(expectErr(result).name).toBe('WorkspaceAuthSignedOut');
	});
});
