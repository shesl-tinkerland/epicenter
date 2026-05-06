/**
 * Remote Action Client Tests
 *
 * Verifies peer-addressed RPC over the shared awareness attachment. These
 * tests cover peer id resolution, proxy path construction, peer misses, and
 * peers leaving while a call is in flight.
 *
 * Key behaviors:
 * - Remote client resolves peer ids from awareness.
 * - Proxy calls send dot-path actions to the low-level RPC attachment.
 * - Peer miss and peer-left failures come from workspace peer addressing.
 */

import { describe, expect, test } from 'bun:test';
import { RpcError } from '@epicenter/sync';
import Type from 'typebox';
import type { Result } from 'wellcrafted/result';
import { Err, isErr, Ok } from 'wellcrafted/result';
import {
	applyAwarenessUpdate,
	encodeAwarenessUpdate,
	removeAwarenessStates,
} from 'y-protocols/awareness';
import * as Y from 'yjs';
import { attachAwareness } from '../document/attach-awareness.js';
import type { SyncRpcAttachment } from '../document/attach-sync.js';
import { PeerIdentity } from '../document/peer-identity.js';
import { defineMutation, defineQuery } from '../shared/actions.js';
import {
	createRemoteClient,
	type RemoteClientOptions,
} from './remote-actions.js';

const TestActions = {
	tabs: {
		close: defineMutation({
			input: Type.Object({ tabIds: Type.Array(Type.Number()) }),
			handler: (_input): { closedCount: number } => ({ closedCount: 0 }),
		}),
	},
	foo: {
		bar: defineMutation({
			input: Type.Object({}),
			handler: (): unknown => undefined,
		}),
	},
	x: defineQuery({ handler: (): unknown => undefined }),
};
type TestActions = typeof TestActions;

type RpcCall = {
	target: number;
	action: string;
	input?: unknown;
	options?: { timeout?: number };
};

function setupRemoteOptions({
	present,
	respond,
	calls = [],
}: {
	present: Record<string, number> | Array<{ peerId: string; clientId: number }>;
	respond: (call: RpcCall) => Promise<Result<unknown, RpcError>>;
	calls?: RpcCall[];
}): RemoteClientOptions & {
	add(peerId: string, clientId: number): void;
	drop(peerId: string): void;
	dropClient(clientId: number): void;
	clientId(peerId: string): number;
	destroy(): void;
} {
	const ydoc = new Y.Doc();
	const awareness = attachAwareness(ydoc, {
		schema: { peer: PeerIdentity },
		initial: { peer: { id: 'self', name: 'Self', platform: 'node' } },
	});
	const remotes = new Map<number, { doc: Y.Doc; peerId: string }>();

	const initialPeers = Array.isArray(present)
		? present
		: Object.entries(present).map(([peerId, clientId]) => ({ peerId, clientId }));

	const addPeer = (peerId: string, clientId: number) => {
		const remoteDoc = new Y.Doc({ guid: peerId });
		remoteDoc.clientID = clientId;
		const remoteAwareness = attachAwareness(remoteDoc, {
			schema: { peer: PeerIdentity },
			initial: { peer: { id: peerId, name: peerId, platform: 'web' } },
		});
		applyAwarenessUpdate(
			awareness.raw,
			encodeAwarenessUpdate(remoteAwareness.raw, [clientId]),
			'test',
		);
		remotes.set(clientId, { doc: remoteDoc, peerId });
	};

	for (const { peerId, clientId } of initialPeers) addPeer(peerId, clientId);

	const rpc: SyncRpcAttachment = {
		async rpc(target, action, input, options) {
			const call = { target, action, input, options };
			calls.push(call);
			return respond(call);
		},
	};

	return {
		awareness,
		rpc,
		add: addPeer,
		drop(peerId: string) {
			const remote = [...remotes.entries()].find(
				([, value]) => value.peerId === peerId,
			);
			if (!remote) return;
			const [clientId, value] = remote;
			removeAwarenessStates(awareness.raw, [clientId], 'test');
			value.doc.destroy();
			remotes.delete(clientId);
		},
		dropClient(clientId: number) {
			const remote = remotes.get(clientId);
			if (!remote) return;
			removeAwarenessStates(awareness.raw, [clientId], 'test');
			remote.doc.destroy();
			remotes.delete(clientId);
		},
		clientId(peerId: string) {
			const remote = [...remotes.entries()].find(
				([, value]) => value.peerId === peerId,
			);
			if (!remote) throw new Error(`missing peer ${peerId}`);
			return remote[0];
		},
		destroy() {
			for (const remote of remotes.values()) remote.doc.destroy();
			ydoc.destroy();
		},
	};
}

describe('createRemoteClient actions', () => {
	test('builds a proxy whose dot-path becomes the rpc action arg', async () => {
		const calls: RpcCall[] = [];
		const options = setupRemoteOptions({
			present: { mac: 42 },
			calls,
			respond: async () => Ok({ closedCount: 1 }),
		});

		const remote = createRemoteClient(options).actions<TestActions>('mac');
		const result = await remote.tabs.close({ tabIds: [1] }, { timeout: 1000 });

		expect(calls).toHaveLength(1);
		expect(calls[0]?.target).toBe(42);
		expect(calls[0]?.action).toBe('tabs.close');
		expect(calls[0]?.input).toEqual({ tabIds: [1] });
		expect(calls[0]?.options).toEqual({ timeout: 1000 });
		expect(result.error).toBeNull();
		expect(result.data).toEqual({ closedCount: 1 });

		options.destroy();
	});

	test('returns PeerNotFound without sending when peer is absent', async () => {
		const calls: RpcCall[] = [];
		const options = setupRemoteOptions({
			present: {},
			calls,
			respond: async () => {
				throw new Error('rpc should not be called');
			},
		});

		const remote = createRemoteClient(options).actions<TestActions>('ghost');
		const result = await remote.foo.bar({});

		expect(calls).toHaveLength(0);
		expect(isErr(result)).toBe(true);
		if (isErr(result)) expect(result.error.name).toBe('PeerNotFound');

		options.destroy();
	});

	test('waits for a peer before sending when waitForPeerMs is set', async () => {
		const calls: RpcCall[] = [];
		const options = setupRemoteOptions({
			present: {},
			calls,
			respond: async () => Ok(undefined),
		});

		const remote = createRemoteClient(options).actions<TestActions>('mac');
		const resultPromise = remote.foo.bar({}, { waitForPeerMs: 50 });

		expect(calls).toHaveLength(0);
		options.add('mac', 33);

		const result = await resultPromise;
		expect(result.error).toBeNull();
		expect(calls).toHaveLength(1);
		expect(calls[0]?.target).toBe(33);

		options.destroy();
	});

	test('uses the lowest client id when duplicate peer ids are present', async () => {
		const calls: RpcCall[] = [];
		const options = setupRemoteOptions({
			present: [
				{ peerId: 'mac', clientId: 9 },
				{ peerId: 'mac', clientId: 4 },
			],
			calls,
			respond: async () => Ok(undefined),
		});

		const remote = createRemoteClient(options).actions<TestActions>('mac');
		const result = await remote.foo.bar({});

		expect(result.error).toBeNull();
		expect(calls).toHaveLength(1);
		expect(calls[0]?.target).toBe(4);

		options.destroy();
	});

	test('passes a wire Result through unchanged when the peer returns one', async () => {
		const options = setupRemoteOptions({
			present: { mac: 1 },
			respond: async () => Err(RpcError.ActionNotFound({ action: 'x' }).error),
		});

		const remote = createRemoteClient(options).actions<TestActions>('mac');
		const result = await remote.x();

		expect(isErr(result)).toBe(true);
		if (isErr(result)) expect(result.error.name).toBe('ActionNotFound');

		options.destroy();
	});

	test('resolves with PeerLeft when the peer drops mid-call', async () => {
		const options = setupRemoteOptions({
			present: { mac: 7 },
			respond: () => new Promise<Result<unknown, RpcError>>(() => {}),
		});

		const remote = createRemoteClient(options).actions<TestActions>('mac');
		const callPromise = remote.tabs.close({ tabIds: [1] });

		options.drop('mac');

		const result = await callPromise;
		expect(isErr(result)).toBe(true);
		if (isErr(result)) expect(result.error.name).toBe('PeerLeft');

		options.destroy();
	});

	test('resolves with PeerLeft when the target client drops but a duplicate peer remains', async () => {
		const options = setupRemoteOptions({
			present: [
				{ peerId: 'mac', clientId: 7 },
				{ peerId: 'mac', clientId: 8 },
			],
			respond: () => new Promise<Result<unknown, RpcError>>(() => {}),
		});

		const remote = createRemoteClient(options).actions<TestActions>('mac');
		const callPromise = remote.tabs.close({ tabIds: [1] });

		options.dropClient(7);

		const result = await callPromise;
		expect(isErr(result)).toBe(true);
		if (isErr(result)) expect(result.error.name).toBe('PeerLeft');

		options.destroy();
	});
});

describe('createRemoteClient', () => {
	test('binds awareness and rpc so callers only pass the peer target', async () => {
		const calls: RpcCall[] = [];
		const options = setupRemoteOptions({
			present: { mac: 42 },
			calls,
			respond: async () => Ok({ closedCount: 1 }),
		});

		const remote = createRemoteClient(options);
		const result = await remote
			.actions<TestActions>('mac')
			.tabs.close({ tabIds: [1] });

		expect(calls).toHaveLength(1);
		expect(calls[0]?.target).toBe(42);
		expect(calls[0]?.action).toBe('tabs.close');
		expect(result.error).toBeNull();
		expect(result.data).toEqual({ closedCount: 1 });

		options.destroy();
	});

	test('describes a peer through the bound system action', async () => {
		const manifest = {
			'tabs.close': {
				type: 'mutation' as const,
				input: TestActions.tabs.close.input,
			},
		};
		const calls: RpcCall[] = [];
		const options = setupRemoteOptions({
			present: { mac: 42 },
			calls,
			respond: async () => Ok(manifest),
		});

		const remote = createRemoteClient(options);
		const result = await remote.describe('mac');

		expect(calls).toHaveLength(1);
		expect(calls[0]?.target).toBe(42);
		expect(calls[0]?.action).toBe('system.describe');
		expect(result.error).toBeNull();
		expect(result.data).toEqual(manifest);

		options.destroy();
	});
});
