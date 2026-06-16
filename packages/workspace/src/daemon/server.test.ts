/**
 * Daemon Server Tests
 *
 * Verifies that `startDaemonServer` binds exactly one socket for an
 * already-claimed daemon lease and exposes an idempotent close operation.
 *
 * Key behaviors:
 * - the configured mount is served over the daemon client
 * - close stops the listener, removes the socket file, and can run twice
 * - /run executes a real action handler over the Unix socket, and
 *   forwards peer calls when `to` is present
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { type ActionRegistry, defineQuery } from '../shared/actions.js';
import { daemonClient } from './client.js';
import { claimDaemonLease, type DaemonLease } from './lease.js';
import { startDaemonServer } from './server.js';
import type { DaemonServedMount } from './types.js';

let originalRuntimeDir: string | undefined;
let runtimeRoot: string;
let workDir: string;

function makeRuntime({
	actions = {},
	collaboration = true,
	dispatch = async () => ({ data: null, error: null }) as never,
}: {
	actions?: ActionRegistry;
	collaboration?: boolean;
	dispatch?: NonNullable<
		DaemonServedMount['runtime']['collaboration']
	>['dispatch'];
} = {}): DaemonServedMount['runtime'] {
	const runtime: DaemonServedMount['runtime'] = { actions };
	if (collaboration) {
		runtime.collaboration = {
			peers: {
				list: () => [],
			},
			status: { phase: 'connected' },
			dispatch,
		};
	}
	return runtime;
}

function claimTestLease(): DaemonLease {
	return expectOk(claimDaemonLease(workDir));
}

beforeEach(() => {
	originalRuntimeDir = process.env.EPICENTER_RUNTIME_DIR;
	// `/tmp/...` is short on every POSIX platform; needed because
	// socketPathFor enforces a strict path-length guard that macOS's
	// `os.tmpdir()` would blow.
	runtimeRoot = mkdtempSync('/tmp/eps-server-rt-');
	process.env.EPICENTER_RUNTIME_DIR = runtimeRoot;
	mkdirSync(runtimeRoot, { recursive: true });
	workDir = mkdtempSync('/tmp/eps-server-dir-');
});

afterEach(() => {
	if (originalRuntimeDir === undefined)
		delete process.env.EPICENTER_RUNTIME_DIR;
	else process.env.EPICENTER_RUNTIME_DIR = originalRuntimeDir;
	rmSync(runtimeRoot, { recursive: true, force: true });
	rmSync(workDir, { recursive: true, force: true });
});

describe('startDaemonServer', () => {
	test('starts the configured mount', async () => {
		const lease = claimTestLease();
		const serverResult = await startDaemonServer({
			lease,
			mount: { mount: 'demo', runtime: makeRuntime() },
		});

		try {
			const server = expectOk(serverResult);

			const data = expectOk(await daemonClient(server.socketPath).peers());
			expect(data).toEqual([]);
		} finally {
			if (serverResult.error === null) await serverResult.data.close();
			lease.release();
		}
	});

	test('close stops the listener, removes the socket, and is idempotent', async () => {
		const lease = claimTestLease();
		const serverResult = await startDaemonServer({
			lease,
			mount: { mount: 'demo', runtime: makeRuntime() },
		});

		try {
			const server = expectOk(serverResult);
			expect(existsSync(server.socketPath)).toBe(true);

			await server.close();
			await server.close();
			expect(existsSync(server.socketPath)).toBe(false);
		} finally {
			if (serverResult.error === null) await serverResult.data.close();
			lease.release();
		}
	});

	test('run executes a real action handler over the socket', async () => {
		const lease = claimTestLease();
		const runtime = makeRuntime({
			actions: {
				echo: defineQuery({ handler: () => 'hello' }),
			},
		});
		const serverResult = await startDaemonServer({
			lease,
			mount: { mount: 'demo', runtime },
		});

		try {
			const server = expectOk(serverResult);
			const data = expectOk(
				await daemonClient(server.socketPath).run({
					actionPath: 'echo',
					input: null,
				}),
			);
			expect(data).toBe('hello');
		} finally {
			if (serverResult.error === null) await serverResult.data.close();
			lease.release();
		}
	});

	test('run executes a local-only mount action over the socket', async () => {
		const lease = claimTestLease();
		const runtime = makeRuntime({
			collaboration: false,
			actions: {
				sync: defineQuery({ handler: () => ({ imported: 1 }) }),
			},
		});
		const serverResult = await startDaemonServer({
			lease,
			mount: { mount: 'mirror', runtime },
		});

		try {
			const server = expectOk(serverResult);
			const data = expectOk(
				await daemonClient(server.socketPath).run({
					actionPath: 'sync',
					input: null,
				}),
			);
			expect(data).toEqual({ imported: 1 });
		} finally {
			if (serverResult.error === null) await serverResult.data.close();
			lease.release();
		}
	});

	test('run with to forwards mount-local action keys over the socket', async () => {
		const lease = claimTestLease();
		let invokedAction = '';
		let invokedTo = '';
		const runtime = makeRuntime({
			dispatch: async (request) => {
				invokedAction = request.action;
				invokedTo = request.to;
				return { data: 'remote-ok', error: null };
			},
		});
		const serverResult = await startDaemonServer({
			lease,
			mount: { mount: 'demo', runtime },
		});

		try {
			const server = expectOk(serverResult);
			const data = expectOk(
				await daemonClient(server.socketPath).run({
					actionPath: 'peer_only_action',
					input: null,
					peer: { to: 'mac', waitMs: 25 },
				}),
			);
			expect(data).toBe('remote-ok');
			expect(invokedAction).toBe('peer_only_action');
			expect(invokedTo).toBe('mac');
		} finally {
			if (serverResult.error === null) await serverResult.data.close();
			lease.release();
		}
	});

	test('run with to rejects invalid wait budgets as a domain error', async () => {
		const lease = claimTestLease();
		const serverResult = await startDaemonServer({
			lease,
			mount: { mount: 'demo', runtime: makeRuntime() },
		});

		try {
			const server = expectOk(serverResult);
			const error = expectErr(
				await daemonClient(server.socketPath).run({
					actionPath: 'peer_only_action',
					input: null,
					peer: { to: 'mac', waitMs: -1 },
				}),
			);
			expect(error.name).toBe('UsageError');
		} finally {
			if (serverResult.error === null) await serverResult.data.close();
			lease.release();
		}
	});

	test('run with to rejects a local-only mount as a usage error', async () => {
		const lease = claimTestLease();
		const serverResult = await startDaemonServer({
			lease,
			mount: {
				mount: 'mirror',
				runtime: makeRuntime({ collaboration: false }),
			},
		});

		try {
			const server = expectOk(serverResult);
			const error = expectErr(
				await daemonClient(server.socketPath).run({
					actionPath: 'sync',
					input: null,
					peer: { to: 'mac', waitMs: 25 },
				}),
			);
			expect(error.name).toBe('UsageError');
		} finally {
			if (serverResult.error === null) await serverResult.data.close();
			lease.release();
		}
	});
});
