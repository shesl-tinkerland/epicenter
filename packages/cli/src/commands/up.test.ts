/**
 * Unit-level tests for `epicenter daemon up`.
 *
 * These tests run `runUp` in-process against tiny project-mount fixtures.
 * They never spawn a child or call `process.exit`; each test owns a temp
 * project and temp runtime root.
 *
 * Auth is injected: every test passes a `createAuthClient` factory to
 * `runUp`. Happy paths return `STUB_AUTH`; the AuthFailed test returns a
 * factory that throws. The real `createMachineAuthClient` is not exercised
 * here, by design - it has its own unit tests in
 * `@epicenter/auth/src/node/machine-auth.test.ts`.
 *
 * Key behaviors:
 * - happy path loads epicenter.config.ts, writes metadata, binds the
 *   socket, and replies to ping
 * - startup failures release the daemon lease
 * - held SQLite leases short-circuit before mount module import
 * - orphan socket files are swept and replaced by a fresh daemon
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { SyncAuthClient } from '@epicenter/auth';
import { MachineAuthStorageError } from '@epicenter/auth/node';
import { asOwnerId } from '@epicenter/identity';
import {
	claimDaemonLease,
	metadataPathFor,
	pingDaemon,
	socketPathFor,
	writeMetadata,
} from '@epicenter/workspace/node';
import { Err, Ok } from 'wellcrafted/result';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { runUp } from './up.js';

const STUB_AUTH = {
	state: {
		status: 'signed-in',
		ownerId: asOwnerId('user-1'),
		keyring: [
			{
				version: 1,
				keyBytesBase64: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=',
			},
		],
	},
	baseURL: 'http://localhost:8787',
	onStateChange: () => () => {},
	startSignIn: async () => Ok(undefined),
	signOut: async () => Ok(undefined),
	fetch: async () => new Response(null, { status: 404 }),
	openWebSocket: async () => {
		throw new Error('STUB_AUTH: openWebSocket not implemented');
	},
	[Symbol.dispose]: () => {},
} satisfies SyncAuthClient;

const stubAuthFactory = async () => Ok(STUB_AUTH);

let originalRuntimeDir: string | undefined;
let runtimeRoot: string;
let workDir: string;

beforeEach(() => {
	originalRuntimeDir = process.env.EPICENTER_RUNTIME_DIR;

	// `/tmp/...` is short on every POSIX platform; needed because
	// socketPathFor enforces a strict path-length guard that macOS's
	// `os.tmpdir()` would blow.
	runtimeRoot = mkdtempSync('/tmp/eps-up-rt-');
	process.env.EPICENTER_RUNTIME_DIR = runtimeRoot;
	mkdirSync(runtimeRoot, { recursive: true });

	workDir = mkdtempSync('/tmp/eps-up-dir-');
});

afterEach(() => {
	if (originalRuntimeDir === undefined)
		delete process.env.EPICENTER_RUNTIME_DIR;
	else process.env.EPICENTER_RUNTIME_DIR = originalRuntimeDir;

	rmSync(runtimeRoot, { recursive: true, force: true });
	rmSync(workDir, { recursive: true, force: true });
});

function markerPath(name: string): string {
	return join(workDir, `${name}.marker`);
}

function writeDemoMount(source: string): string {
	const dir = join(workDir, 'workspaces', 'demo');
	mkdirSync(dir, { recursive: true });
	const path = join(dir, 'daemon.ts');
	writeFileSync(path, source);
	return path;
}

function writeDemoConfig(): void {
	writeFileSync(
		join(workDir, 'epicenter.config.ts'),
		[
			"import demo from './workspaces/demo/daemon.ts';",
			'',
			'export default demo;',
			'',
		].join('\n'),
	);
}

function writeRuntimeMount({
	onImportMarker,
	onDisposeMarker,
}: {
	onImportMarker?: string;
	onDisposeMarker?: string;
} = {}) {
	writeDemoMount(`
		import { writeFileSync } from 'node:fs';
		${onImportMarker ? `writeFileSync(${JSON.stringify(onImportMarker)}, 'imported');` : ''}

		const actions = {};
		const collaboration = {
			actions,
			whenConnected: new Promise(() => {}),
			status: { phase: 'connected' },
			onStatusChange: () => () => {},
			devices: {
				list: () => [],
				subscribe: () => () => {},
			},
			dispatch: async () => {
				throw new Error('fixture does not dispatch');
			},
		};

		export default {
			name: 'demo',
			async open() {
				return {
					collaboration,
					async [Symbol.asyncDispose]() {
						${onDisposeMarker ? `writeFileSync(${JSON.stringify(onDisposeMarker)}, 'disposed');` : ''}
					},
				};
			},
		};
	`);
	writeDemoConfig();
}

describe('runUp: happy path', () => {
	test('writes metadata, binds socket, replies to ping', async () => {
		writeRuntimeMount();

		const handle = expectOk(
			await runUp({
				epicenterRoot: workDir,
				quiet: true,
				createAuthClient: stubAuthFactory,
			}),
		);
		try {
			expect(existsSync(metadataPathFor(workDir))).toBe(true);
			expect(handle.metadata.pid).toBe(process.pid);
			expect(handle.metadata.discoveredAt).toEqual(expect.any(String));
			expect(handle.mounts).toHaveLength(1);
			expect(handle.mounts[0]?.mount).toBe('demo');
			expect(
				readFileSync(join(workDir, 'epicenter.config.ts'), 'utf8'),
			).toContain('export default demo');

			const sockPath = socketPathFor(workDir);
			expect(existsSync(sockPath)).toBe(true);
			const ok = await pingDaemon(sockPath, 1000);
			expect(ok).toBe(true);
		} finally {
			await handle.teardown();
		}
		expect(existsSync(metadataPathFor(workDir))).toBe(false);
		expect(existsSync(socketPathFor(workDir))).toBe(false);
	});
});

describe('runUp: failure cleanup', () => {
	test('surfaces the auth error and releases the lease when createAuthClient returns Err', async () => {
		const error = expectErr(
			await runUp({
				epicenterRoot: workDir,
				quiet: true,
				createAuthClient: async () =>
					Err(
						MachineAuthStorageError.NoSavedSession({
							filePath: '/tmp/fake-auth.json',
							baseURL: 'https://example.com',
						}).error,
					),
			}),
		);

		expect(error.name).toBe('NoSavedSession');
		expect(error.message).toContain('no saved session');
		const lease = expectOk(claimDaemonLease(workDir));
		lease.release();
	});

	test('errors and scaffolds nothing when config is missing', async () => {
		const error = expectErr(
			await runUp({
				epicenterRoot: workDir,
				quiet: true,
				createAuthClient: stubAuthFactory,
			}),
		);

		expect(error.name).toBe('ProjectConfigNotFound');
		expect(existsSync(join(workDir, 'epicenter.config.ts'))).toBe(false);
		expect(existsSync(join(workDir, '.epicenter'))).toBe(false);

		const lease = expectOk(claimDaemonLease(workDir));
		lease.release();
	});

	test('does not overwrite an existing config when provisioning project data', async () => {
		writeRuntimeMount();
		const original = [
			"import demo from './workspaces/demo/daemon.ts';",
			'',
			'export default demo; // keep me',
			'',
		].join('\n');
		writeFileSync(join(workDir, 'epicenter.config.ts'), original);
		const gitignore = 'custom-rule\n';
		mkdirSync(join(workDir, '.epicenter'), { recursive: true });
		writeFileSync(join(workDir, '.epicenter', '.gitignore'), gitignore);

		const handle = expectOk(
			await runUp({
				epicenterRoot: workDir,
				quiet: true,
				createAuthClient: stubAuthFactory,
			}),
		);

		try {
			expect(readFileSync(join(workDir, 'epicenter.config.ts'), 'utf8')).toBe(
				original,
			);
			expect(
				readFileSync(join(workDir, '.epicenter', '.gitignore'), 'utf8'),
			).toBe(gitignore);
		} finally {
			await handle.teardown();
		}
	});

	test('scaffolds a root .gitignore that tracks only the config', async () => {
		writeRuntimeMount();

		const handle = expectOk(
			await runUp({
				epicenterRoot: workDir,
				quiet: true,
				createAuthClient: stubAuthFactory,
			}),
		);

		try {
			const rootGitignore = readFileSync(join(workDir, '.gitignore'), 'utf8');
			// Ignore-all + allowlist: the config (and the ignore file) are tracked,
			// every generated child folder is not.
			expect(rootGitignore).toContain('/*');
			expect(rootGitignore).toContain('!/.gitignore');
			expect(rootGitignore).toContain('!/epicenter.config.ts');
		} finally {
			await handle.teardown();
		}
	});

	test('does not overwrite an existing root .gitignore', async () => {
		writeRuntimeMount();
		const custom = '# mine\n/build\n';
		writeFileSync(join(workDir, '.gitignore'), custom);

		const handle = expectOk(
			await runUp({
				epicenterRoot: workDir,
				quiet: true,
				createAuthClient: stubAuthFactory,
			}),
		);

		try {
			expect(readFileSync(join(workDir, '.gitignore'), 'utf8')).toBe(custom);
		} finally {
			await handle.teardown();
		}
	});

	test('does not scaffold a root .gitignore once the namespace exists', async () => {
		// `.epicenter/` present means a prior run already established the folder;
		// a plain `up` must not retroactively write a `/*` rule into a folder the
		// user may have turned into a git repo since.
		writeRuntimeMount();
		mkdirSync(join(workDir, '.epicenter'), { recursive: true });

		const handle = expectOk(
			await runUp({
				epicenterRoot: workDir,
				quiet: true,
				createAuthClient: stubAuthFactory,
			}),
		);

		try {
			expect(existsSync(join(workDir, '.gitignore'))).toBe(false);
		} finally {
			await handle.teardown();
		}
	});

	test('releases the daemon lease when config loading fails', async () => {
		writeFileSync(join(workDir, 'epicenter.config.ts'), 'export default {;\n');

		const error = expectErr(
			await runUp({
				epicenterRoot: workDir,
				quiet: true,
				createAuthClient: stubAuthFactory,
			}),
		);
		expect(error.name).toBe('ProjectConfigImportFailed');

		const lease = expectOk(claimDaemonLease(workDir));
		lease.release();
	});

	test('releases the daemon lease when mount startup fails', async () => {
		writeDemoMount(`
			export default {
				name: 'demo',
				async open() {
					throw new Error('mount failed');
				},
			};
		`);
		writeDemoConfig();

		const error = expectErr(
			await runUp({
				epicenterRoot: workDir,
				quiet: true,
				createAuthClient: stubAuthFactory,
			}),
		);

		expect(error).toMatchObject({ name: 'MountOpenFailed', mount: 'demo' });
		// A failed mount open leaves nothing bound behind.
		expect(existsSync(metadataPathFor(workDir))).toBe(false);
		expect(existsSync(socketPathFor(workDir))).toBe(false);
		const lease = expectOk(claimDaemonLease(workDir));
		lease.release();
	});

	test('returns MetadataWriteFailed and tears down when metadata path is blocked', async () => {
		writeRuntimeMount();
		mkdirSync(metadataPathFor(workDir));

		const error = expectErr(
			await runUp({
				epicenterRoot: workDir,
				quiet: true,
				createAuthClient: stubAuthFactory,
			}),
		);

		expect(error.name).toBe('MetadataWriteFailed');
		expect(existsSync(socketPathFor(workDir))).toBe(false);
		const lease = expectOk(claimDaemonLease(workDir));
		lease.release();
	});
});

describe('runUp: already running', () => {
	test('does not import mounts when the daemon lease is held', async () => {
		const lease = expectOk(claimDaemonLease(workDir));
		const importMarker = markerPath('import');
		writeRuntimeMount({ onImportMarker: importMarker });

		try {
			const error = expectErr(
				await runUp({
					epicenterRoot: workDir,
					quiet: true,
					createAuthClient: stubAuthFactory,
				}),
			);

			expect(error.name).toBe('AlreadyRunning');
			expect(existsSync(importMarker)).toBe(false);
		} finally {
			lease.release();
		}
	});
});

describe('runUp: orphan path', () => {
	test('proceeds cleanly when metadata pid is dead and socket is phantom', async () => {
		const sockPath = socketPathFor(workDir);
		mkdirSync(runtimeRoot, { recursive: true });

		writeFileSync(sockPath, '');
		writeMetadata(workDir, {
			pid: 99999999,
			dir: workDir,
			startedAt: new Date().toISOString(),
			cliVersion: '0.0.0',
			discoveredAt: new Date().toISOString(),
		});
		writeRuntimeMount();

		const handle = expectOk(
			await runUp({
				epicenterRoot: workDir,
				quiet: true,
				createAuthClient: stubAuthFactory,
			}),
		);

		try {
			expect(handle.metadata.pid).toBe(process.pid);
			expect(existsSync(socketPathFor(workDir))).toBe(true);
		} finally {
			await handle.teardown();
		}
	});
});
