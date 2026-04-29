import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as Y from 'yjs';

import { attachIpcSyncClient } from './client.js';
import { attachIpcSyncServer, type IpcSyncServer } from './server.js';
import { bindIpcSocket, type IpcListener } from './listener.js';

let workdir: string;

beforeEach(() => {
	workdir = mkdtempSync(join(tmpdir(), 'ipc-listener-'));
});

afterEach(() => {
	rmSync(workdir, { recursive: true, force: true });
});

describe('bindIpcSocket', () => {
	it('round-trips Y.Doc state between a real unix socket and a peer', async () => {
		const socketPath = join(workdir, 'daemon.sock');

		const serverDoc = new Y.Doc();
		serverDoc.getMap('m').set('hello', 'world');
		const fujiServer = attachIpcSyncServer(serverDoc, { workspace: 'fuji' });

		const listener = await bindIpcSocket({
			socketPath,
			servers: new Map<string, IpcSyncServer>([['fuji', fujiServer]]),
		});

		const clientDoc = new Y.Doc();
		const ipc = attachIpcSyncClient(clientDoc, {
			socket: socketPath,
			workspace: 'fuji',
			deviceId: 'device-test',
		});

		await ipc.whenSynced;
		expect(clientDoc.getMap('m').get('hello')).toBe('world');

		clientDoc.getMap('m').set('from-script', 'yes');
		await new Promise((r) => setTimeout(r, 30));
		expect(serverDoc.getMap('m').get('from-script')).toBe('yes');

		await ipc.close();
		await listener.close();
		await fujiServer.close();
		serverDoc.destroy();
		clientDoc.destroy();
	});

	it('rejects an unknown workspace selector with a typed error', async () => {
		const socketPath = join(workdir, 'daemon.sock');
		const fujiDoc = new Y.Doc();
		const fujiServer = attachIpcSyncServer(fujiDoc, { workspace: 'fuji' });

		const listener: IpcListener = await bindIpcSocket({
			socketPath,
			servers: new Map<string, IpcSyncServer>([['fuji', fujiServer]]),
		});

		const clientDoc = new Y.Doc();
		const ipc = attachIpcSyncClient(clientDoc, {
			socket: socketPath,
			workspace: 'tab-manager',
			deviceId: 'device-test',
		});

		await expect(ipc.whenSynced).rejects.toBeDefined();
		expect(ipc.status.phase).toBe('failed');
		// status reason carries the daemon's variant name verbatim
		const status = ipc.status;
		if (status.phase === 'failed') {
			expect(status.reason).toContain('NoSuchWorkspace');
		}

		await ipc.close();
		await listener.close();
		await fujiServer.close();
		fujiDoc.destroy();
		clientDoc.destroy();
	});

	it('round-trips a single 64 KB frame without losing bytes (backpressure)', async () => {
		// Bun's unix-socket SO_SNDBUF is ~7 KB; a naive `socket.write` on a 64 KB
		// frame returns 0 and silently drops the rest. The write-queue + drain
		// hook in listener/client must ride out the kernel buffer fill.
		const socketPath = join(workdir, 'daemon.sock');

		const big = 'x'.repeat(64 * 1024);
		const serverDoc = new Y.Doc();
		serverDoc.getMap('m').set('blob', big);
		const fujiServer = attachIpcSyncServer(serverDoc, { workspace: 'fuji' });

		const listener = await bindIpcSocket({
			socketPath,
			servers: new Map<string, IpcSyncServer>([['fuji', fujiServer]]),
		});

		const clientDoc = new Y.Doc();
		const ipc = attachIpcSyncClient(clientDoc, {
			socket: socketPath,
			workspace: 'fuji',
			deviceId: 'device-test',
		});

		await ipc.whenSynced;
		expect(clientDoc.getMap('m').get('blob')).toBe(big);

		// Push a large value the other direction too, to exercise the client's queue.
		const big2 = 'y'.repeat(96 * 1024);
		clientDoc.getMap('m').set('reverse', big2);
		await new Promise((r) => setTimeout(r, 60));
		expect(serverDoc.getMap('m').get('reverse')).toBe(big2);

		await ipc.close();
		await listener.close();
		await fujiServer.close();
		serverDoc.destroy();
		clientDoc.destroy();
	});

	it('routes a multi-workspace listener to the right server', async () => {
		const socketPath = join(workdir, 'daemon.sock');

		const fujiDoc = new Y.Doc();
		fujiDoc.getMap('m').set('which', 'fuji');
		const fujiServer = attachIpcSyncServer(fujiDoc, { workspace: 'fuji' });

		const tabsDoc = new Y.Doc();
		tabsDoc.getMap('m').set('which', 'tab-manager');
		const tabsServer = attachIpcSyncServer(tabsDoc, {
			workspace: 'tab-manager',
		});

		const listener = await bindIpcSocket({
			socketPath,
			servers: new Map<string, IpcSyncServer>([
				['fuji', fujiServer],
				['tab-manager', tabsServer],
			]),
		});

		const clientFuji = new Y.Doc();
		const ipcFuji = attachIpcSyncClient(clientFuji, {
			socket: socketPath,
			workspace: 'fuji',
			deviceId: 'd1',
		});

		const clientTabs = new Y.Doc();
		const ipcTabs = attachIpcSyncClient(clientTabs, {
			socket: socketPath,
			workspace: 'tab-manager',
			deviceId: 'd2',
		});

		await Promise.all([ipcFuji.whenSynced, ipcTabs.whenSynced]);

		expect(clientFuji.getMap('m').get('which')).toBe('fuji');
		expect(clientTabs.getMap('m').get('which')).toBe('tab-manager');

		await ipcFuji.close();
		await ipcTabs.close();
		await listener.close();
		await fujiServer.close();
		await tabsServer.close();
		fujiDoc.destroy();
		tabsDoc.destroy();
		clientFuji.destroy();
		clientTabs.destroy();
	});
});
