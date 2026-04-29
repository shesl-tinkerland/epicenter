/**
 * Unit-level tests for `epicenter serve`.
 *
 * These tests run `runServe` in-process with a fake `LoadedWorkspace` /
 * `SyncAttachment` so we never spawn a child or call `process.exit`.
 *
 * Cases:
 *   1. Happy path: bindUnixSocket is called, metadata is written, ping replies "pong".
 *   2. Stale-auth fast-fail: whenConnected rejects with a SyncFailedError-shaped
 *      cause; runServe returns ConnectFailed with that cause.
 *   3. Already-running: pre-write metadata for `process.pid` + a real listening socket;
 *      runServe throws "server already running (pid=X)".
 *   4. Orphan: pre-write metadata for a dead pid + phantom socket; runServe proceeds
 *      cleanly (no throw).
 */

import {
	afterEach,
	beforeEach,
	describe,
	expect,
	test,
} from 'bun:test';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Ok } from 'wellcrafted/result';

import {
	bindUnixSocket,
	metadataPathFor,
	socketPathFor,
	writeMetadata,
} from '@epicenter/workspace';
import type { LoadConfigResult, LoadedWorkspace } from '../load-config';
import { runServe } from './serve';

let originalXdg: string | undefined;
let runtimeRoot: string;
let workDir: string;
let homeRoot: string;
let originalHome: string | undefined;

beforeEach(() => {
	originalXdg = process.env.XDG_RUNTIME_DIR;
	originalHome = process.env.HOME;

	runtimeRoot = mkdtempSync(join(tmpdir(), 'ep-up-'));
	process.env.XDG_RUNTIME_DIR = runtimeRoot;
	mkdirSync(join(runtimeRoot, 'epicenter'), { recursive: true });

	homeRoot = mkdtempSync(join(tmpdir(), 'ep-home-'));
	process.env.HOME = homeRoot;

	workDir = mkdtempSync(join(tmpdir(), 'ep-dir-'));
	// Seed an empty config so the workDir looks like a real epicenter project.
	writeFileSync(join(workDir, 'epicenter.config.ts'), 'export {};\n');
});

afterEach(() => {
	if (originalXdg === undefined) delete process.env.XDG_RUNTIME_DIR;
	else process.env.XDG_RUNTIME_DIR = originalXdg;
	if (originalHome === undefined) delete process.env.HOME;
	else process.env.HOME = originalHome;

	rmSync(runtimeRoot, { recursive: true, force: true });
	rmSync(homeRoot, { recursive: true, force: true });
	rmSync(workDir, { recursive: true, force: true });
});

type FakeOptions = {
	readyPromise?: Promise<unknown>;
};

function makeFakeWorkspace(opts: FakeOptions = {}): LoadedWorkspace {
	return {
		[Symbol.dispose]() {
			/* no-op */
		},
		whenReady: opts.readyPromise ?? Promise.resolve(),
		sync: {
			whenConnected: opts.readyPromise ?? Promise.resolve(),
			status: { phase: 'connected', hasLocalChanges: false },
			onStatusChange: () => () => {},
			peers: () => new Map(),
			observe: () => () => {},
			// Unused fields; cast through unknown to keep the fake minimal.
		} as unknown as LoadedWorkspace['sync'],
	};
}

function makeFakeConfig(workspace: LoadedWorkspace): LoadConfigResult {
	return {
		entries: [{ name: 'default', workspace }],
		async [Symbol.asyncDispose]() {
			workspace[Symbol.dispose]();
		},
	};
}

describe('runServe: happy path', () => {
	test('writes metadata, binds socket, replies to ping', async () => {
		const workspace = makeFakeWorkspace();
		const config = makeFakeConfig(workspace);

		const { data: handle, error } = await runServe(
			{
				dir: workDir,
				quiet: true,
			},
			{
				loadConfig: async () => Ok(config),
			},
		);
		expect(error).toBeNull();
		if (error) throw new Error('runServe failed unexpectedly');

		// Metadata was written.
		expect(existsSync(metadataPathFor(workDir))).toBe(true);
		expect(handle.metadata.pid).toBe(process.pid);
		expect(handle.entries).toHaveLength(1);
		expect(handle.entries[0]!.name).toBe('default');

		// Socket is bound; ping it via a fresh connect using the real client.
		const { pingDaemon } = await import('@epicenter/workspace');
		const sockPath = socketPathFor(workDir);
		expect(existsSync(sockPath)).toBe(true);
		const ok = await pingDaemon(sockPath, 1000);
		expect(ok).toBe(true);

		await handle.teardown();
		// Cleanup: metadata and socket gone.
		expect(existsSync(metadataPathFor(workDir))).toBe(false);
		expect(existsSync(sockPath)).toBe(false);
	});
});

describe('runServe: stale-auth fast-fail', () => {
	test('returns ConnectFailed when whenConnected rejects with SyncFailedError', async () => {
		// Shape matches `SyncFailedError.AuthRejected({ code }).error` from
		// `@epicenter/workspace`: an Error-like with `name: 'AuthRejected'`
		// and a `code` string. The yargs handler renders this via
		// `formatStartupError`; here we assert the cause flows through unchanged.
		const authRejected = Object.assign(
			new Error('[attachSync] server rejected auth: invalid_token'),
			{ name: 'AuthRejected', code: 'invalid_token' },
		);
		const rejecting = Promise.reject(authRejected);
		// Pre-attach a swallow so the rejection isn't reported as unhandled
		// before runServe awaits it.
		rejecting.catch(() => {});
		const workspace = makeFakeWorkspace({ readyPromise: rejecting });
		const config = makeFakeConfig(workspace);

		const { error } = await runServe(
			{
				dir: workDir,
				quiet: true,
			},
			{
				loadConfig: async () => Ok(config),
			},
		);
		expect(error?.name).toBe('ConnectFailed');
		if (error?.name === 'ConnectFailed') {
			expect(error.cause).toMatchObject({
				name: 'AuthRejected',
				code: 'invalid_token',
			});
		}
	});
});

describe('runServe: already running', () => {
	test('returns AlreadyRunning when a live daemon is detected', async () => {
		const sockPath = socketPathFor(workDir);
		mkdirSync(join(runtimeRoot, 'epicenter'), { recursive: true });

		const { Hono } = await import('hono');
		const { Ok } = await import('wellcrafted/result');
		const app = new Hono().post('/ping', (c) => c.json(Ok('pong' as const)));
		const server = await bindUnixSocket(sockPath, app);

		writeMetadata(workDir, {
			pid: process.pid,
			dir: workDir,
		});

		try {
			const { error } = await runServe(
				{
					dir: workDir,
					quiet: true,
				},
				{
					loadConfig: async () => Ok(makeFakeConfig(makeFakeWorkspace())),
				},
			);
			expect(error?.name).toBe('AlreadyRunning');
			if (error?.name === 'AlreadyRunning') {
				expect(error.pid).toBe(process.pid);
			}
		} finally {
			server.stop();
		}
	});
});

describe('runServe: orphan path', () => {
	test('proceeds cleanly when metadata pid is dead and socket is phantom', async () => {
		const sockPath = socketPathFor(workDir);
		mkdirSync(join(runtimeRoot, 'epicenter'), { recursive: true });

		// Phantom (regular file, not a real socket) + dead-pid metadata.
		writeFileSync(sockPath, '');
		writeMetadata(workDir, {
			pid: 99999999,
			dir: workDir,
		});

		const workspace = makeFakeWorkspace();
		const config = makeFakeConfig(workspace);

		const { data: handle, error } = await runServe(
			{
				dir: workDir,
				quiet: true,
			},
			{
				loadConfig: async () => Ok(config),
			},
		);
		expect(error).toBeNull();
		if (error) throw new Error('runServe failed unexpectedly');

		// Daemon came up; fresh metadata for *this* pid was written.
		expect(handle.metadata.pid).toBe(process.pid);
		expect(existsSync(socketPathFor(workDir))).toBe(true);

		await handle.teardown();
	});
});
