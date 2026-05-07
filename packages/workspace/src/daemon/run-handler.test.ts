/**
 * executeRun peer dispatch tests.
 *
 * Verifies the daemon preserves remote client errors in one `/run` envelope
 * before the response crosses the IPC boundary.
 */

import { describe, expect, test } from 'bun:test';

import type { AwarenessAttachment } from '../document/attach-awareness.js';
import type { SyncStatus } from '../document/attach-sync.js';
import type { PeerAwarenessSchema } from '../document/peer-identity.js';
import type { RemoteClient } from '../rpc/remote-actions.js';
import { defineMutation, defineQuery } from '../shared/actions.js';
import type { RunSyncStatus } from './run-errors.js';
import { executeRun } from './run-handler.js';
import type { StartedDaemonRoute } from './types.js';

type Runtime = StartedDaemonRoute['runtime'];

function fakeAwareness(): AwarenessAttachment<PeerAwarenessSchema> {
	return {
		peers: () => new Map(),
		observe: () => () => {},
	} as unknown as AwarenessAttachment<PeerAwarenessSchema>;
}

function fakeRemote(overrides: Partial<RemoteClient> = {}): RemoteClient {
	return {
		actions: () => ({}) as never,
		describe: async () => ({ data: {}, error: null }),
		invoke: async () => ({ data: null, error: null }),
		...overrides,
	} as RemoteClient;
}

function fakeSync(
	status: SyncStatus = { phase: 'connected' },
): Runtime['sync'] {
	return {
		whenConnected: Promise.resolve(),
		whenDisposed: Promise.resolve(),
		status,
		onStatusChange: () => () => {},
		reconnect() {},
		attachRpc: () => ({ rpc: async () => ({ data: null, error: null }) }),
	} as Runtime['sync'];
}

function fakeRuntime(
	actions: Runtime['actions'],
	extra: Record<string, unknown> = {},
): Runtime {
	return {
		actions,
		awareness: fakeAwareness(),
		sync: fakeSync(),
		remote: fakeRemote(),
		async [Symbol.asyncDispose]() {},
		...extra,
	};
}

function fakeEntry({
	remote = {},
	syncStatus,
}: {
	remote?: Partial<RemoteClient>;
	syncStatus?: SyncStatus;
} = {}): StartedDaemonRoute {
	const runtime = fakeRuntime(
		{
			tabs: {
				list: defineQuery({
					handler: () => [],
				}),
			},
		},
		{
			remote: fakeRemote(remote),
			...(syncStatus ? { sync: fakeSync(syncStatus) } : {}),
		},
	);

	return { route: 'demo', runtime };
}

describe('executeRun peer dispatch', () => {
	test('peer miss returns RunError.RemoteCallFailed with sync status', async () => {
		let invokeCalls = 0;
		const syncStatus: SyncStatus = {
			phase: 'connecting',
			retries: 2,
			lastError: { type: 'connection' },
		};
		const runSyncStatus = {
			phase: 'connecting',
			retries: 2,
			lastErrorType: 'connection',
		} satisfies RunSyncStatus;
		const entry = fakeEntry({
			syncStatus,
			remote: {
				async invoke(peerTarget, _action, _input, options) {
					invokeCalls++;
					return {
						data: null,
						error: {
							name: 'PeerNotFound',
							message: `no peer matches peer id "${peerTarget}"`,
							peerTarget,
							sawPeers: true,
							waitMs: options?.waitForPeerMs ?? 0,
						},
					};
				},
			},
		});

		const result = await executeRun([entry], {
			actionPath: 'demo.tabs.list',
			input: undefined,
			peerTarget: 'ghost',
			waitMs: 25,
		});

		expect(invokeCalls).toBe(1);
		expect(result.error).not.toBeNull();
		if (result.error === null) throw new Error('expected RemoteCallFailed');
		expect(result.error.name).toBe('RemoteCallFailed');
		if (result.error.name !== 'RemoteCallFailed') {
			throw new Error(`expected RemoteCallFailed, got ${result.error.name}`);
		}
		expect(result.error.peerTarget).toBe('ghost');
		expect(result.error.syncStatus).toEqual(runSyncStatus);
		expect(result.error.cause).toMatchObject({
			name: 'PeerNotFound',
			peerTarget: 'ghost',
			sawPeers: true,
			waitMs: 25,
		});
	});

	test('remote dispatch sends only the inner action path', async () => {
		let rpcAction = '';
		const entry = fakeEntry({
			remote: {
				async invoke(_peerId, action) {
					rpcAction = action;
					return { data: [], error: null };
				},
			},
		});

		const result = await executeRun([entry], {
			actionPath: 'demo.tabs.list',
			input: undefined,
			peerTarget: 'mac',
			waitMs: 25,
		});

		expect(result.error).toBeNull();
		expect(rpcAction).toBe('tabs.list');
	});
});

describe('executeRun route-prefixed routing', () => {
	test('invokes action under the selected daemon route', async () => {
		const runtime = fakeRuntime({
			notes: {
				add: defineMutation({
					handler: () => ({ body: 'hello' }),
				}),
			},
		});
		const entry = {
			route: 'notes',
			runtime,
		};

		const result = await executeRun([entry], {
			actionPath: 'notes.notes.add',
			input: { body: 'hello' },
			waitMs: 25,
		});

		expect(result.error).toBeNull();
		expect(result.data).toEqual({ body: 'hello' });
	});

	test('ignores action leaves outside the canonical action root', async () => {
		const runtime = fakeRuntime(
			{},
			{
				notes: {
					add: defineMutation({
						handler: () => ({ body: 'hello' }),
					}),
				},
			},
		);
		const entry = {
			route: 'notes',
			runtime,
		};

		const result = await executeRun([entry], {
			actionPath: 'notes.notes.add',
			input: { body: 'hello' },
			waitMs: 25,
		});

		expect(result.error?.name).toBe('UsageError');
	});

	test('missing path suggests action-root-relative sibling', async () => {
		const runtime = fakeRuntime({
			notes: {
				add: defineMutation({
					handler: () => ({ body: 'hello' }),
				}),
			},
		});
		const entry = {
			route: 'notes',
			runtime,
		};

		const result = await executeRun([entry], {
			actionPath: 'notes.add',
			input: { body: 'hello' },
			waitMs: 25,
		});

		expect(result.error?.name).toBe('UsageError');
		if (result.error?.name !== 'UsageError') {
			throw new Error('expected UsageError');
		}
		expect(result.error.suggestions).toEqual(['  notes.notes.add  (mutation)']);
	});

	test('unknown route returns available route suggestions', async () => {
		const result = await executeRun(
			[
				fakeEntry({}),
				{
					route: 'tasks',
					runtime: fakeRuntime({}),
				},
			],
			{
				actionPath: 'missing.actions.add',
				input: undefined,
				waitMs: 25,
			},
		);

		expect(result.error?.name).toBe('UsageError');
		if (result.error?.name !== 'UsageError') {
			throw new Error('expected UsageError');
		}
		expect(result.error.message).toBe(
			'No daemon route "missing". Available: demo, tasks',
		);
		expect(result.error.suggestions).toEqual(['  demo', '  tasks']);
	});
});
