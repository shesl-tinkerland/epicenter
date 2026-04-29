import { describe, expect, it } from 'bun:test';
import { Awareness as YAwareness } from 'y-protocols/awareness';
import * as Y from 'yjs';

import {
	attachIpcSyncServer,
	type IpcChannel,
	type IpcPreamble,
} from './sync-hub.js';

// ---------------------------------------------------------------------------
// In-memory channel pair: each side observes frames the other side sends.
// Mirrors a duplex SOCK_STREAM after framing has already been applied.
// ---------------------------------------------------------------------------

function createChannelPair(): {
	server: IpcChannel;
	client: IpcChannel;
} {
	const serverFrameListeners = new Set<(b: Uint8Array) => void>();
	const clientFrameListeners = new Set<(b: Uint8Array) => void>();
	const serverCloseListeners = new Set<() => void>();
	const clientCloseListeners = new Set<() => void>();
	let closed = false;

	function closeBoth() {
		if (closed) return;
		closed = true;
		for (const cb of serverCloseListeners) cb();
		for (const cb of clientCloseListeners) cb();
	}

	const server: IpcChannel = {
		sendFrame(bytes) {
			if (closed) return;
			for (const cb of clientFrameListeners) cb(bytes);
		},
		onFrame(cb) {
			serverFrameListeners.add(cb);
			return () => serverFrameListeners.delete(cb);
		},
		close: closeBoth,
		onClose(cb) {
			serverCloseListeners.add(cb);
			return () => serverCloseListeners.delete(cb);
		},
	};
	const client: IpcChannel = {
		sendFrame(bytes) {
			if (closed) return;
			for (const cb of serverFrameListeners) cb(bytes);
		},
		onFrame(cb) {
			clientFrameListeners.add(cb);
			return () => clientFrameListeners.delete(cb);
		},
		close: closeBoth,
		onClose(cb) {
			clientCloseListeners.add(cb);
			return () => clientCloseListeners.delete(cb);
		},
	};
	return { server, client };
}

// ---------------------------------------------------------------------------
// Bare peer: a Y.Doc plus the minimal sync wire glue needed to exercise the
// hub from the test. We keep this independent of attachIpcSyncClient so that
// commit 1's tests stand on their own (the client lands in commit 2).
// ---------------------------------------------------------------------------

import * as decoding from 'lib0/decoding';
import {
	MESSAGE_TYPE,
	encodeAwareness,
	encodeAwarenessStates,
	encodeSyncStep1,
	encodeSyncUpdate,
	handleSyncPayload,
	type SyncMessageType,
} from '@epicenter/sync';
import {
	applyAwarenessUpdate,
	encodeAwarenessUpdate,
} from 'y-protocols/awareness';

function attachBarePeer(
	ydoc: Y.Doc,
	channel: IpcChannel,
	opts?: { awareness?: YAwareness; origin?: symbol },
) {
	const origin = opts?.origin ?? Symbol('peer');
	const awareness = opts?.awareness;
	channel.onFrame((bytes) => {
		const decoder = decoding.createDecoder(bytes);
		const messageType = decoding.readVarUint(decoder);
		switch (messageType) {
			case MESSAGE_TYPE.SYNC: {
				const syncType = decoding.readVarUint(decoder) as SyncMessageType;
				const payload = decoding.readVarUint8Array(decoder);
				const response = handleSyncPayload({
					syncType,
					payload,
					doc: ydoc,
					origin,
				});
				if (response) channel.sendFrame(response);
				break;
			}
			case MESSAGE_TYPE.AWARENESS: {
				if (!awareness) break;
				const update = decoding.readVarUint8Array(decoder);
				applyAwarenessUpdate(awareness, update, origin);
				break;
			}
		}
	});
	const onDocUpdate = (update: Uint8Array, updateOrigin: unknown) => {
		if (updateOrigin === origin) return;
		channel.sendFrame(encodeSyncUpdate({ update }));
	};
	ydoc.on('updateV2', onDocUpdate);
	if (awareness) {
		const onAwareness = (
			{
				added,
				updated,
				removed,
			}: { added: number[]; updated: number[]; removed: number[] },
			updateOrigin: unknown,
		) => {
			if (updateOrigin === origin) return;
			const changedClients = added.concat(updated).concat(removed);
			channel.sendFrame(
				encodeAwareness({
					update: encodeAwarenessUpdate(awareness, changedClients),
				}),
			);
		};
		awareness.on('update', onAwareness);
	}
	channel.sendFrame(encodeSyncStep1({ doc: ydoc }));
	if (awareness && awareness.getLocalState() !== null) {
		channel.sendFrame(
			encodeAwarenessStates({
				awareness,
				clients: [ydoc.clientID],
			}),
		);
	}
	return { origin };
}

function nextTick() {
	return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('attachIpcSyncServer', () => {
	it('converges initial state from server to peer via STEP1/STEP2', async () => {
		const serverDoc = new Y.Doc();
		serverDoc.getMap('m').set('greeting', 'hello');
		serverDoc.getMap('m').set('answer', 42);

		const peerDoc = new Y.Doc();
		const server = attachIpcSyncServer(serverDoc, { workspace: 'fuji' });
		const { server: serverCh, client: peerCh } = createChannelPair();

		const sessionPromise = server.acceptSession({
			channel: serverCh,
			preamble: makePreamble({ clientId: 1001 }),
		});
		attachBarePeer(peerDoc, peerCh);

		await nextTick();
		await nextTick();

		expect(peerDoc.getMap('m').get('greeting')).toBe('hello');
		expect(peerDoc.getMap('m').get('answer')).toBe(42);

		await server.close();
		await sessionPromise;
		serverDoc.destroy();
		peerDoc.destroy();
	});

	it('broadcasts a peer write to the server doc', async () => {
		const serverDoc = new Y.Doc();
		const peerDoc = new Y.Doc();
		const server = attachIpcSyncServer(serverDoc, { workspace: 'fuji' });
		const { server: serverCh, client: peerCh } = createChannelPair();

		const sessionPromise = server.acceptSession({
			channel: serverCh,
			preamble: makePreamble({ clientId: 1002 }),
		});
		attachBarePeer(peerDoc, peerCh);

		await nextTick();
		peerDoc.getMap('m').set('from-peer', true);
		await nextTick();
		await nextTick();

		expect(serverDoc.getMap('m').get('from-peer')).toBe(true);

		await server.close();
		await sessionPromise;
		serverDoc.destroy();
		peerDoc.destroy();
	});

	it('fans out writes from one peer to a sibling peer', async () => {
		const serverDoc = new Y.Doc();
		const server = attachIpcSyncServer(serverDoc, { workspace: 'fuji' });
		const peerA = new Y.Doc();
		const peerB = new Y.Doc();
		const pairA = createChannelPair();
		const pairB = createChannelPair();

		const sessionA = server.acceptSession({
			channel: pairA.server,
			preamble: makePreamble({ clientId: 2001 }),
		});
		const sessionB = server.acceptSession({
			channel: pairB.server,
			preamble: makePreamble({ clientId: 2002 }),
		});
		attachBarePeer(peerA, pairA.client);
		attachBarePeer(peerB, pairB.client);

		await nextTick();
		await nextTick();

		peerA.getMap('m').set('shared', 'A wrote this');
		await nextTick();
		await nextTick();

		expect(serverDoc.getMap('m').get('shared')).toBe('A wrote this');
		expect(peerB.getMap('m').get('shared')).toBe('A wrote this');

		await server.close();
		await sessionA;
		await sessionB;
		serverDoc.destroy();
		peerA.destroy();
		peerB.destroy();
	});

	it('reports active sessions via peers()', async () => {
		const serverDoc = new Y.Doc();
		const server = attachIpcSyncServer(serverDoc, { workspace: 'fuji' });
		const pair = createChannelPair();
		const session = server.acceptSession({
			channel: pair.server,
			preamble: makePreamble({
				clientId: 3001,
				deviceId: 'device-x',
				isEphemeral: false,
			}),
		});

		await nextTick();
		const snapshot = server.peers();
		expect(snapshot).toHaveLength(1);
		expect(snapshot[0]!.clientId).toBe(3001);
		expect(snapshot[0]!.deviceId).toBe('device-x');
		expect(snapshot[0]!.isEphemeral).toBe(false);

		await server.close();
		await session;
		serverDoc.destroy();
	});

	it('kicks the prior session when the same clientId reconnects', async () => {
		const serverDoc = new Y.Doc();
		const server = attachIpcSyncServer(serverDoc, { workspace: 'fuji' });
		const pair1 = createChannelPair();
		const pair2 = createChannelPair();

		const session1 = server.acceptSession({
			channel: pair1.server,
			preamble: makePreamble({ clientId: 4001 }),
		});

		await nextTick();
		expect(server.peers()).toHaveLength(1);

		const session2 = server.acceptSession({
			channel: pair2.server,
			preamble: makePreamble({ clientId: 4001 }),
		});

		await nextTick();
		await session1; // prior session resolves after kick
		expect(server.peers()).toHaveLength(1);
		expect(server.peers()[0]!.clientId).toBe(4001);

		await server.close();
		await session2;
		serverDoc.destroy();
	});

	it('exchanges awareness state when an Awareness instance is attached', async () => {
		const serverDoc = new Y.Doc();
		const serverAwareness = new YAwareness(serverDoc);
		const server = attachIpcSyncServer(serverDoc, {
			workspace: 'fuji',
			awareness: serverAwareness,
		});

		const peerDoc = new Y.Doc();
		const peerAwareness = new YAwareness(peerDoc);
		peerAwareness.setLocalState({ device: { id: 'peer-1' } });

		const pair = createChannelPair();
		const sessionPromise = server.acceptSession({
			channel: pair.server,
			preamble: makePreamble({ clientId: peerDoc.clientID }),
		});
		attachBarePeer(peerDoc, pair.client, { awareness: peerAwareness });

		await nextTick();
		await nextTick();

		const states = serverAwareness.getStates();
		expect(states.has(peerDoc.clientID)).toBe(true);
		expect(
			(states.get(peerDoc.clientID) as { device: { id: string } }).device.id,
		).toBe('peer-1');

		await server.close();
		await sessionPromise;

		// After session teardown, peer awareness state is removed.
		expect(serverAwareness.getStates().has(peerDoc.clientID)).toBe(false);

		serverDoc.destroy();
		peerDoc.destroy();
	});

	it('teardown via close() resolves whenDisposed and clears sessions', async () => {
		const serverDoc = new Y.Doc();
		const server = attachIpcSyncServer(serverDoc, { workspace: 'fuji' });
		const pair = createChannelPair();
		const sessionPromise = server.acceptSession({
			channel: pair.server,
			preamble: makePreamble({ clientId: 5001 }),
		});

		await nextTick();
		await server.close();
		await sessionPromise;
		await server.whenDisposed;
		expect(server.peers()).toHaveLength(0);

		serverDoc.destroy();
	});

	it('teardown via doc destroy implicitly closes the hub', async () => {
		const serverDoc = new Y.Doc();
		const server = attachIpcSyncServer(serverDoc, { workspace: 'fuji' });
		const pair = createChannelPair();
		const sessionPromise = server.acceptSession({
			channel: pair.server,
			preamble: makePreamble({ clientId: 6001 }),
		});

		await nextTick();
		serverDoc.destroy();
		await sessionPromise;
		await server.whenDisposed;
		expect(server.peers()).toHaveLength(0);
	});
});

function makePreamble(overrides: Partial<IpcPreamble>): IpcPreamble {
	return {
		workspace: 'fuji',
		deviceId: overrides.deviceId ?? 'device-test',
		clientId: overrides.clientId ?? 1,
		isEphemeral: overrides.isEphemeral ?? true,
		...overrides,
	};
}
