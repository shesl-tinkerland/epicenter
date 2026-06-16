/**
 * Unit-level tests for `epicenter daemon up`.
 *
 * These tests run `runUp` in-process against tiny root-and-mount fixtures.
 * They never spawn a child or call `process.exit`; each test owns a temp
 * Epicenter root and temp runtime root.
 *
 * Auth is injected lazily: collaborative fixtures pass a `createAuthClient`
 * factory to `runUp`, and local-only or config-failure paths use a factory
 * that throws if startup reaches for auth. The real `createMachineAuthClient`
 * is not exercised here. It has its own unit tests in
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
	daemonClient,
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
/** A machine with no saved session: the daemon runs with a `null` session. */
const signedOutFactory = async () =>
	Err(
		MachineAuthStorageError.NoSavedSession({
			filePath: '/tmp/fake-auth.json',
			baseURL: 'https://example.com',
		}).error,
	);
/** Used only where startup short-circuits before auth is ever loaded. */
const failIfAuthCreated = async () => {
	throw new Error('must not create auth');
};

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

/**
 * A minimal valid singular config: a local mount that opens with no session and
 * serves nothing. Used by tests that only exercise namespace scaffolding.
 */
const TRIVIAL_MOUNT_CONFIG = [
	'export default {',
	"\tname: 'demo',",
	'\topen: () => ({ actions: {}, async [Symbol.asyncDispose]() {} }),',
	'};',
	'',
].join('\n');

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
			peers: {
				list: () => [],
				subscribe: () => () => {},
			},
			dispatch: async () => {
				throw new Error('fixture does not dispatch');
			},
		};

		export default {
			name: 'demo',
			async open(ctx) {
				if (!ctx.session) {
					return { inactive: true, reason: 'sign in to enable demo' };
				}
				return {
					actions,
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
			expect(handle.opened.status).toBe('started');
			if (handle.opened.status !== 'started') {
				throw new Error('expected started mount');
			}
			expect(handle.opened.entry.mount).toBe('demo');
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

	test('serves a local-only mount without collaboration', async () => {
		writeDemoMount(`
			const sync = () => ({ imported: 2 });
			sync.type = 'query';
			sync.description = 'Sync local mirror';
			const actions = {
				sync,
			};

			export default {
				name: 'mirror',
				async open() {
					return {
						actions,
						async [Symbol.asyncDispose]() {},
					};
				},
			};
		`);
		writeDemoConfig();

		const handle = expectOk(
			await runUp({
				epicenterRoot: workDir,
				quiet: true,
				createAuthClient: signedOutFactory,
			}),
		);
		try {
			const client = daemonClient(socketPathFor(workDir));
			const snapshot = expectOk(await client.list());
			expect(snapshot.mount).toBe('mirror');
			expect(Object.keys(snapshot.actions)).toEqual(['sync']);
			expect(snapshot.actions.sync?.description).toBe('Sync local mirror');
			expect(expectOk(await client.peers())).toEqual([]);
			expect(
				expectOk(
					await client.run({
						actionPath: 'sync',
						input: null,
					}),
				),
			).toEqual({ imported: 2 });
		} finally {
			await handle.teardown();
		}
	});
});

describe('runUp: failure cleanup', () => {
	test('reports a session mount as inactive when signed out, without serving it', async () => {
		writeRuntimeMount();

		const handle = expectOk(
			await runUp({
				epicenterRoot: workDir,
				quiet: true,
				createAuthClient: signedOutFactory,
			}),
		);

		try {
			expect(handle.opened).toEqual({
				status: 'inactive',
				entry: { mount: 'demo', reason: 'sign in to enable demo' },
			});
			// Inactive means no runtime exists, so there is no action server.
			expect(await pingDaemon(socketPathFor(workDir), 1000)).toBe(false);
			expect(existsSync(metadataPathFor(workDir))).toBe(false);
		} finally {
			await handle.teardown();
		}
		const lease = expectOk(claimDaemonLease(workDir));
		lease.release();
	});

	test('surfaces non-session auth errors and releases the lease', async () => {
		writeRuntimeMount();

		const error = expectErr(
			await runUp({
				epicenterRoot: workDir,
				quiet: true,
				createAuthClient: async () =>
					Err(
						MachineAuthStorageError.PermissionsTooOpen({
							filePath: '/tmp/fake-auth.json',
							mode: 0o644,
						}).error,
					),
			}),
		);

		expect(error.name).toBe('PermissionsTooOpen');
		expect(error.message).toContain('too permissive');
		const lease = expectOk(claimDaemonLease(workDir));
		lease.release();
	});

	test('errors and scaffolds nothing when config is missing', async () => {
		const error = expectErr(
			await runUp({
				epicenterRoot: workDir,
				quiet: true,
				createAuthClient: signedOutFactory,
			}),
		);

		expect(error.name).toBe('EpicenterConfigNotFound');
		expect(existsSync(join(workDir, 'epicenter.config.ts'))).toBe(false);
		expect(existsSync(join(workDir, '.epicenter'))).toBe(false);

		const lease = expectOk(claimDaemonLease(workDir));
		lease.release();
	});

	test('does not overwrite an existing config when provisioning root data', async () => {
		const original = `${TRIVIAL_MOUNT_CONFIG}\n// keep me\n`;
		writeFileSync(join(workDir, 'epicenter.config.ts'), original);
		const gitignore = 'custom-rule\n';
		mkdirSync(join(workDir, '.epicenter'), { recursive: true });
		writeFileSync(join(workDir, '.epicenter', '.gitignore'), gitignore);

		const handle = expectOk(
			await runUp({
				epicenterRoot: workDir,
				quiet: true,
				createAuthClient: signedOutFactory,
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

	test('does not scaffold a root .gitignore', async () => {
		writeFileSync(join(workDir, 'epicenter.config.ts'), TRIVIAL_MOUNT_CONFIG);

		const handle = expectOk(
			await runUp({
				epicenterRoot: workDir,
				quiet: true,
				createAuthClient: stubAuthFactory,
			}),
		);

		try {
			expect(existsSync(join(workDir, '.gitignore'))).toBe(false);
			expect(
				readFileSync(join(workDir, '.epicenter', '.gitignore'), 'utf8'),
			).toBe('*\n');
		} finally {
			await handle.teardown();
		}
	});

	test('does not overwrite an existing root .gitignore', async () => {
		writeFileSync(join(workDir, 'epicenter.config.ts'), TRIVIAL_MOUNT_CONFIG);
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
		writeFileSync(join(workDir, 'epicenter.config.ts'), TRIVIAL_MOUNT_CONFIG);
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
				createAuthClient: signedOutFactory,
			}),
		);
		expect(error.name).toBe('EpicenterConfigImportFailed');

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
				createAuthClient: signedOutFactory,
			}),
		);

		expect(error.name).toBe('MountOpenFailed');
		const lease = expectOk(claimDaemonLease(workDir));
		lease.release();
	});

	test('keeps .epicenter/.gitignore when mount startup fails after namespace claim', async () => {
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

		expect(error).toMatchObject({
			name: 'MountOpenFailed',
			mount: 'demo',
		});
		expect(existsSync(join(workDir, '.gitignore'))).toBe(false);
		expect(
			readFileSync(join(workDir, '.epicenter', '.gitignore'), 'utf8'),
		).toBe('*\n');
		const lease = expectOk(claimDaemonLease(workDir));
		lease.release();
	});

	test('leaves no socket or metadata when the mount fails', async () => {
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
				createAuthClient: signedOutFactory,
			}),
		);

		expect(error).toMatchObject({
			name: 'MountOpenFailed',
			mount: 'demo',
		});
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
					// A held lease short-circuits before auth is ever loaded; this
					// factory throws if startup reaches for it.
					createAuthClient: failIfAuthCreated,
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
