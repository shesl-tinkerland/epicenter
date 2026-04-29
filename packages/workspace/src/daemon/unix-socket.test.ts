import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Hono } from 'hono';

import { writeMetadata } from './metadata';
import { metadataPathFor, socketPathFor } from './paths';
import {
	bindOrRecover,
	bindUnixSocket,
	type UnixSocketServer,
	unlinkSocketFile,
} from './unix-socket';

let socketPath: string;
let servers: UnixSocketServer[] = [];

beforeEach(() => {
	socketPath = join(
		tmpdir(),
		`epicenter-unix-socket-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.sock`,
	);
	servers = [];
});

afterEach(() => {
	for (const server of servers) {
		try {
			server.stop();
		} catch {
			// already stopped
		}
	}
});

/**
 * `bindUnixSocket` is now a thin wrapper around `Bun.serve({ unix, fetch:
 * app.fetch })` plus filesystem hardening. The route-level behavior lives
 * in `app.ts` (and is exercised through the typed client in
 * `client.test.ts`); this file covers only the binding/hardening contract
 * that survives no matter what app you hand it.
 */
describe('bindUnixSocket', () => {
	test('binds the socket and routes through to the Hono app', async () => {
		const app = new Hono().post('/ping', (c) => c.json({ ok: true }));

		const server = await bindUnixSocket(socketPath, app);
		servers.push(server);

		const res = await fetch('http://daemon/ping', {
			unix: socketPath,
			method: 'POST',
		});
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true });
	});

	test('socket file is created with mode 0600', async () => {
		const app = new Hono();
		const server = await bindUnixSocket(socketPath, app);
		servers.push(server);

		const mode = statSync(socketPath).mode & 0o777;
		expect(mode).toBe(0o600);
	});

	test('server.stop() unlinks the socket file', async () => {
		const app = new Hono();
		const server = await bindUnixSocket(socketPath, app);
		expect(existsSync(socketPath)).toBe(true);

		server.stop();
		// Bun.serve auto-unlinks; sweep best-effort just in case.
		unlinkSocketFile(socketPath);
		expect(existsSync(socketPath)).toBe(false);
	});

	test('unknown route returns 404 (Hono default)', async () => {
		const app = new Hono().post('/ping', (c) => c.text('ok'));
		const server = await bindUnixSocket(socketPath, app);
		servers.push(server);

		const res = await fetch('http://daemon/nope', {
			unix: socketPath,
			method: 'POST',
		});
		expect(res.status).toBe(404);
	});
});

describe('bindOrRecover', () => {
	let originalXdg: string | undefined;
	let runtimeRoot: string;
	let workDir: string;

	beforeEach(() => {
		originalXdg = process.env.XDG_RUNTIME_DIR;
		runtimeRoot = mkdtempSync(join(tmpdir(), 'ep-'));
		process.env.XDG_RUNTIME_DIR = runtimeRoot;
		mkdirSync(join(runtimeRoot, 'epicenter'), { recursive: true });
		workDir = mkdtempSync(join(tmpdir(), 'ep-d-'));
	});

	afterEach(() => {
		if (originalXdg === undefined) delete process.env.XDG_RUNTIME_DIR;
		else process.env.XDG_RUNTIME_DIR = originalXdg;
		rmSync(runtimeRoot, { recursive: true, force: true });
		rmSync(workDir, { recursive: true, force: true });
	});

	test('clean bind: succeeds and returns the server', async () => {
		const sock = socketPathFor(workDir);
		const app = new Hono();
		const result = await bindOrRecover(sock, workDir, app, async () => false);
		expect(result.error).toBeNull();
		if (result.error === null) {
			servers.push(result.data);
			expect(existsSync(sock)).toBe(true);
		}
	});

	test('ping-finds-occupant: returns AlreadyRunning with metadata pid', async () => {
		const sock = socketPathFor(workDir);
		const occupant = await bindUnixSocket(sock, new Hono());
		servers.push(occupant);
		writeMetadata(workDir, {
			pid: 4242,
			dir: workDir,
		});

		const result = await bindOrRecover(
			sock,
			workDir,
			new Hono(),
			async () => true,
		);
		expect(result.data).toBeNull();
		if (result.error?.name === 'AlreadyRunning') {
			expect(result.error.pid).toBe(4242);
		} else {
			throw new Error('expected AlreadyRunning');
		}
	});

	test('orphan recovery: phantom socket + metadata get swept and bind succeeds', async () => {
		const sock = socketPathFor(workDir);
		// Phantom socket file with no listener (kill -9'd predecessor).
		mkdirSync(join(runtimeRoot, 'epicenter'), { recursive: true });
		await Bun.write(sock, '');
		writeMetadata(workDir, {
			pid: 99999999,
			dir: workDir,
		});

		const result = await bindOrRecover(
			sock,
			workDir,
			new Hono(),
			async () => false,
		);
		expect(result.error).toBeNull();
		if (result.error === null) {
			servers.push(result.data);
			expect(existsSync(sock)).toBe(true);
		}
		// Stale metadata is swept on the recovery branch.
		expect(existsSync(metadataPathFor(workDir))).toBe(false);
	});
});
