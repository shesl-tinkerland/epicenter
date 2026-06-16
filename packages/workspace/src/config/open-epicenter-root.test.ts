/**
 * Tests for `openEpicenterRoot`, the single daemon entry point.
 *
 * `openEpicenterRoot` imports `epicenter.config.ts`, claims the Epicenter
 * folder, and opens the one mount it declares, so these tests drive it through
 * real config files on disk:
 * - a missing config returns a structured `EpicenterConfigNotFound` Result
 * - a valid config opens the declared mount; the result is `{ status:
 *   'started' }` or `{ status: 'inactive' }`
 * - the daemon never gates on auth: it receives an auth client (or `null`) and
 *   hands the resulting session to the mount, which decides for itself
 * - a mount that returns `inactive(reason)` is reported, not raised
 * - a thrown `open(ctx)` becomes a structured `MountOpenFailed`
 * - an invalid mount name fails at config load, before the folder is claimed
 *
 * Config-shape validation is pinned separately in
 * `config/load-epicenter-config.test.ts`. Auth loading and its storage errors
 * are the CLI's job, pinned in `packages/cli/src/commands/up.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { asOwnerId } from '@epicenter/identity';
import { expectErr, expectOk } from 'wellcrafted/testing';

import {
	openEpicenterRoot,
	type WorkspaceAuthClient,
} from './open-epicenter-root.js';

let epicenterRoot: string;

beforeEach(() => {
	epicenterRoot = mkdtempSync(join(tmpdir(), 'open-epicenter-root-'));
});

afterEach(() => {
	rmSync(epicenterRoot, { recursive: true, force: true });
});

function writeConfig(source: string): void {
	writeFileSync(join(epicenterRoot, 'epicenter.config.ts'), source);
}

function signedIn(): WorkspaceAuthClient {
	return {
		state: {
			status: 'signed-in',
			ownerId: asOwnerId('test-user'),
		},
		openWebSocket: () => Promise.resolve({} as WebSocket),
		fetch: () => Promise.resolve(new Response()),
		onStateChange: () => () => {},
	};
}

/** A runtime literal whose dispose is a no-op, written into a config. */
const RUNTIME = '{ actions: {}, async [Symbol.asyncDispose]() {} }';

/**
 * A mount that needs the session: it returns a runtime when signed in, else the
 * inline `inactive` signal (a config on disk cannot import `inactive`, but the
 * value is just `{ inactive: true, reason }`).
 */
function sessionMount(name: string): string {
	return `{
		name: '${name}',
		open: (ctx) => ctx.session
			? (${RUNTIME})
			: ({ inactive: true, reason: 'sign in to enable ${name}' }),
	}`;
}

/**
 * A config whose mount writes its `ctx.nodeId` to `captured-node-id` so a
 * test can assert the identity the runtime received without exporting it
 * through the result.
 */
function captureNodeIdConfig(name: string): string {
	return `import { writeFileSync } from 'node:fs';
		import { join } from 'node:path';
		export default {
			name: '${name}',
			open: (ctx) => {
				writeFileSync(join(ctx.epicenterRoot, 'captured-node-id'), ctx.nodeId);
				return ${RUNTIME};
			},
		};\n`;
}

function readCapturedNodeId(root: string): string {
	return readFileSync(join(root, 'captured-node-id'), 'utf8');
}

describe('openEpicenterRoot', () => {
	test('returns a structured not-found error instead of throwing', async () => {
		const result = await openEpicenterRoot({
			epicenterRoot,
			auth: signedIn(),
		});
		const error = expectErr(result);
		expect(error).toMatchObject({
			name: 'EpicenterConfigNotFound',
			epicenterConfigPath: join(epicenterRoot, 'epicenter.config.ts'),
		});
	});

	test('opens the declared mount and claims the folder', async () => {
		writeConfig(
			`export default { name: 'alpha', open: () => (${RUNTIME}) };\n`,
		);

		const result = await openEpicenterRoot({ epicenterRoot, auth: null });
		const opened = expectOk(result);
		expect(opened.status).toBe('started');
		expect(opened.entry.mount).toBe('alpha');
		expect(
			await Bun.file(join(epicenterRoot, '.epicenter', '.gitignore')).exists(),
		).toBe(true);
	});

	test('opens a local mount with a null session when signed out', async () => {
		writeConfig(
			`export default { name: 'mirror', open: () => (${RUNTIME}) };\n`,
		);

		const result = await openEpicenterRoot({ epicenterRoot, auth: null });
		const opened = expectOk(result);
		expect(opened.status).toBe('started');
		expect(opened.entry.mount).toBe('mirror');
	});

	test('reports the mount as inactive when its session is missing', async () => {
		writeConfig(`export default ${sessionMount('fuji')};\n`);

		const result = await openEpicenterRoot({ epicenterRoot, auth: null });
		const opened = expectOk(result);
		expect(opened.status).toBe('inactive');
		expect(opened.entry).toEqual({
			mount: 'fuji',
			reason: 'sign in to enable fuji',
		});
	});

	test('opens a session mount once signed in', async () => {
		writeConfig(`export default ${sessionMount('fuji')};\n`);

		const result = await openEpicenterRoot({
			epicenterRoot,
			auth: signedIn(),
		});
		const opened = expectOk(result);
		expect(opened.status).toBe('started');
		expect(opened.entry.mount).toBe('fuji');
	});

	test('wraps a thrown open in a structured MountOpenFailed', async () => {
		writeConfig(
			`export default { name: 'boom', open() { throw new Error('boom'); } };\n`,
		);

		const result = await openEpicenterRoot({ epicenterRoot, auth: null });
		expect(expectErr(result)).toMatchObject({
			name: 'MountOpenFailed',
			mount: 'boom',
		});
	});

	test('rejects an invalid mount name before claiming the folder', async () => {
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

		const result = await openEpicenterRoot({ epicenterRoot, auth: null });
		expect(expectErr(result)).toMatchObject({
			name: 'EpicenterConfigInvalid',
			detail: expect.stringContaining('the mount name "__proto__" is invalid'),
		});
		expect(await Bun.file(join(epicenterRoot, 'opened')).exists()).toBe(false);
		expect(await Bun.file(join(epicenterRoot, '.epicenter')).exists()).toBe(
			false,
		);
	});

	test('hands the mount a durable node id, stable across reopen', async () => {
		writeConfig(captureNodeIdConfig('alpha'));

		expect(
			(await openEpicenterRoot({ epicenterRoot, auth: null })).data?.status,
		).toBe('started');
		const first = readCapturedNodeId(epicenterRoot);
		expect(first).toMatch(/^[a-z0-9]{16}$/);

		// A second open (a daemon restart) reuses the persisted id.
		expect(
			(await openEpicenterRoot({ epicenterRoot, auth: null })).data?.status,
		).toBe('started');
		expect(readCapturedNodeId(epicenterRoot)).toBe(first);
	});

	test('gives two roots of the same app distinct node ids', async () => {
		writeConfig(captureNodeIdConfig('alpha'));
		await openEpicenterRoot({ epicenterRoot, auth: null });
		const idA = readCapturedNodeId(epicenterRoot);

		const otherRoot = mkdtempSync(join(tmpdir(), 'open-epicenter-root-'));
		try {
			writeFileSync(
				join(otherRoot, 'epicenter.config.ts'),
				captureNodeIdConfig('alpha'),
			);
			await openEpicenterRoot({ epicenterRoot: otherRoot, auth: null });
			expect(readCapturedNodeId(otherRoot)).not.toBe(idA);
		} finally {
			rmSync(otherRoot, { recursive: true, force: true });
		}
	});

	test('returns a structured claim error before opening the mount', async () => {
		writeFileSync(join(epicenterRoot, '.epicenter'), 'not a directory');
		writeConfig(
			`import { writeFileSync } from 'node:fs';
			import { join } from 'node:path';
			export default {
				name: 'fuji',
				open: () => {
					writeFileSync(join(import.meta.dirname, 'opened'), 'opened');
					return ${RUNTIME};
				},
			};\n`,
		);

		const result = await openEpicenterRoot({ epicenterRoot, auth: null });
		expect(expectErr(result)).toMatchObject({
			name: 'EpicenterFolderClaimFailed',
			epicenterRoot,
		});
		expect(await Bun.file(join(epicenterRoot, 'opened')).exists()).toBe(false);
	});
});
