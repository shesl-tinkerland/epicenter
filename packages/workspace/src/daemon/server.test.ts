/**
 * Daemon Server Tests
 *
 * Verifies that `startDaemonServer` validates route names, binds exactly one
 * socket for an already-claimed daemon lease, and exposes an idempotent close
 * operation.
 *
 * Key behaviors:
 * - valid routes are served over the daemon client
 * - invalid route declarations fail before binding a socket
 * - responsive legacy sockets return AlreadyRunning instead of being clobbered
 * - close stops the listener, removes the socket file, and can run twice
 * - /run dispatches a real action handler over the Unix socket
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineQuery } from '../shared/actions.js';
import { daemonClient } from './client.js';
import { claimDaemonLease, type DaemonLease } from './lease.js';
import { startDaemonServer } from './server.js';
import type { DaemonRuntime } from './types.js';
import { bindUnixSocket } from './unix-socket.js';

let originalXdg: string | undefined;
let runtimeRoot: string;
let workDir: string;

function makeRuntime(
	actions: DaemonRuntime['actions'] = {},
): DaemonRuntime {
	return {
		actions,
		async [Symbol.asyncDispose]() {
			/* no-op */
		},
		awareness: {
			peers: () => new Map(),
		},
	} as unknown as DaemonRuntime;
}

function claimTestLease(): DaemonLease {
	const lease = claimDaemonLease(workDir);
	expect(lease.error).toBeNull();
	if (lease.error !== null) throw new Error('expected daemon lease');
	return lease.data;
}

function expectStartedServer(
	result: Awaited<ReturnType<typeof startDaemonServer>>,
) {
	expect(result.error).toBeNull();
	if (result.error !== null) throw result.error;
	return result.data;
}

beforeEach(() => {
	originalXdg = process.env.XDG_RUNTIME_DIR;
	runtimeRoot = mkdtempSync(join(tmpdir(), 'ep-server-'));
	process.env.XDG_RUNTIME_DIR = runtimeRoot;
	mkdirSync(join(runtimeRoot, 'epicenter'), { recursive: true });
	workDir = mkdtempSync(join(tmpdir(), 'ep-server-dir-'));
});

afterEach(() => {
	if (originalXdg === undefined) delete process.env.XDG_RUNTIME_DIR;
	else process.env.XDG_RUNTIME_DIR = originalXdg;
	rmSync(runtimeRoot, { recursive: true, force: true });
	rmSync(workDir, { recursive: true, force: true });
});

describe('startDaemonServer', () => {
	test('starts the configured daemon routes', async () => {
		const lease = claimTestLease();
		const serverResult = await startDaemonServer({
			lease,
			routes: [{ route: 'demo', runtime: makeRuntime() }],
		});

		try {
			const server = expectStartedServer(serverResult);

			const result = await daemonClient(server.socketPath).peers();
			expect(result.error).toBeNull();
			expect(result.data).toEqual([]);
		} finally {
			if (serverResult.error === null) await serverResult.data.close();
			lease.release();
		}
	});

	test('returns RouteNameRejected before binding duplicate routes', async () => {
		const lease = claimTestLease();
		try {
			const result = await startDaemonServer({
				lease,
				routes: [
					{ route: 'demo', runtime: {} as never },
					{ route: 'demo', runtime: {} as never },
				],
			});
			expect(result.data).toBeNull();
			expect(result.error).toMatchObject({
				name: 'RouteNameRejected',
				route: 'demo',
				reason: 'duplicate',
			});
			expect(existsSync(lease.socketPath)).toBe(false);
		} finally {
			lease.release();
		}
	});

	test('returns RouteNameRejected before binding invalid routes', async () => {
		const lease = claimTestLease();
		try {
			const result = await startDaemonServer({
				lease,
				routes: [{ route: 'bad.route', runtime: {} as never }],
			});
			expect(result.data).toBeNull();
			expect(result.error).toMatchObject({
				name: 'RouteNameRejected',
				route: 'bad.route',
				reason: 'invalid',
			});
			expect(existsSync(lease.socketPath)).toBe(false);
		} finally {
			lease.release();
		}
	});

	test('close stops the listener, removes the socket, and is idempotent', async () => {
		const lease = claimTestLease();
		const serverResult = await startDaemonServer({
			lease,
			routes: [{ route: 'demo', runtime: makeRuntime() }],
		});

		try {
			const server = expectStartedServer(serverResult);
			expect(existsSync(server.socketPath)).toBe(true);

			await server.close();
			await server.close();
			expect(existsSync(server.socketPath)).toBe(false);
		} finally {
			if (serverResult.error === null) await serverResult.data.close();
			lease.release();
		}
	});

	test('run dispatches to a real action handler over the socket', async () => {
		const lease = claimTestLease();
		const runtime = makeRuntime({
			echo: defineQuery({ handler: () => 'hello' }),
		});
		const serverResult = await startDaemonServer({
			lease,
			routes: [{ route: 'demo', runtime }],
		});

		try {
			const server = expectStartedServer(serverResult);
			const result = await daemonClient(server.socketPath).run({
				actionPath: 'demo.echo',
				input: null,
				waitMs: 25,
			});

			expect(result.error).toBeNull();
			expect(result.data).toBe('hello');
		} finally {
			if (serverResult.error === null) await serverResult.data.close();
			lease.release();
		}
	});

	test('returns AlreadyRunning when a responsive legacy socket exists', async () => {
		const lease = claimTestLease();
		const occupant = bindUnixSocket({
			socketPath: lease.socketPath,
			fetch: () => new Response('ok'),
		});
		try {
			const second = await startDaemonServer({
				lease,
				routes: [{ route: 'demo', runtime: makeRuntime() }],
			});
			expect(second.data).toBeNull();
			expect(second.error?.name).toBe('AlreadyRunning');
		} finally {
			await occupant.stop(true).catch(() => {
				// best-effort
			});
			lease.release();
		}
	});
});
