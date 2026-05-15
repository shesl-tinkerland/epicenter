/**
 * executeRun peer dispatch tests.
 *
 * Verifies the daemon preserves remote dispatch errors in one `/run` envelope
 * before the response crosses the IPC boundary. The presence surface is
 * faked here so the test can exercise `peers.list()` and the
 * `collab.dispatch` path without spinning up real Yjs sync.
 */

import { describe, expect, test } from 'bun:test';
import type { Result } from 'wellcrafted/result';

import type { SyncStatus } from '../document/internal/sync-supervisor.js';
import type { PresenceEntry } from '../document/presence.js';
import { DispatchError } from '../document/rpc.js';
import type { ActionRegistry } from '../shared/actions.js';
import { defineMutation, defineQuery } from '../shared/actions.js';
import type { RunSyncStatus } from './run-errors.js';
import { executeRun } from './run-handler.js';
import type { DaemonServedRoute } from './types.js';

type FakeDispatch = (
	action: string,
	input: unknown,
	options: { to: string; signal: AbortSignal },
) => Promise<Result<unknown, DispatchError>>;

function fakeEntry({
	route = 'demo',
	actions = {
		tabs_list: defineQuery({ handler: () => [] }),
	},
	syncStatus = { phase: 'connected' },
	knownPeers = [],
	dispatch = async () => ({ data: null, error: null }),
}: {
	route?: string;
	actions?: ActionRegistry;
	syncStatus?: SyncStatus;
	knownPeers?: string[];
	dispatch?: FakeDispatch;
} = {}): DaemonServedRoute {
	const peers: PresenceEntry[] = knownPeers.map((replicaId) => ({
		connId: `${replicaId}-conn`,
		replicaId,
		subject: 'test-user',
	}));
	return {
		route,
		runtime: {
			collaboration: {
				actions,
				status: syncStatus,
				peers: {
					list: () => peers,
				},
				dispatch,
			},
		},
	};
}

describe('executeRun peer dispatch', () => {
	test('peer miss returns RunError.PeerNotFound with sync status', async () => {
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
		const entry = fakeEntry({ syncStatus, knownPeers: [] });

		const result = await executeRun([entry], {
			actionPath: 'demo.tabs_list',
			input: undefined,
			peerTarget: 'ghost',
			waitMs: 25,
		});

		expect(result.error?.name).toBe('PeerNotFound');
		if (result.error?.name !== 'PeerNotFound') {
			throw new Error(`expected PeerNotFound, got ${result.error?.name}`);
		}
		expect(result.error.peerTarget).toBe('ghost');
		expect(result.error.syncStatus).toEqual(runSyncStatus);
	});

	test('remote dispatch sends only the action key, to the resolved connId', async () => {
		let invokedAction = '';
		let invokedTo = '';
		const entry = fakeEntry({
			knownPeers: ['mac'],
			dispatch: async (action, _input, { to }) => {
				invokedAction = action;
				invokedTo = to;
				return { data: [], error: null };
			},
		});

		const result = await executeRun([entry], {
			actionPath: 'demo.tabs_list',
			input: undefined,
			peerTarget: 'mac',
			waitMs: 25,
		});

		expect(result.error).toBeNull();
		expect(invokedAction).toBe('tabs_list');
		expect(invokedTo).toBe('mac-conn');
	});

	test('remote dispatch surfaces DispatchError unchanged', async () => {
		const entry = fakeEntry({
			knownPeers: ['mac'],
			dispatch: async () =>
				DispatchError.ActionFailed({
					action: 'tabs_list',
					cause: new Error('boom'),
				}),
		});

		const result = await executeRun([entry], {
			actionPath: 'demo.tabs_list',
			input: undefined,
			peerTarget: 'mac',
			waitMs: 25,
		});

		expect(result.error?.name).toBe('RemoteCallFailed');
		if (result.error?.name !== 'RemoteCallFailed') {
			throw new Error('expected RemoteCallFailed');
		}
		expect(result.error.cause).toMatchObject({ name: 'ActionFailed' });
	});
});

describe('executeRun route-prefixed routing', () => {
	test('invokes action under the selected daemon route', async () => {
		const entry = fakeEntry({
			route: 'notes',
			actions: {
				notes_add: defineMutation({
					handler: () => ({ body: 'hello' }),
				}),
			},
		});

		const result = await executeRun([entry], {
			actionPath: 'notes.notes_add',
			input: { body: 'hello' },
			waitMs: 25,
		});

		expect(result.error).toBeNull();
		expect(result.data).toEqual({ body: 'hello' });
	});

	test('missing prefix suggests action-root-relative sibling', async () => {
		const entry = fakeEntry({
			route: 'notes',
			actions: {
				notes_add: defineMutation({
					handler: () => ({ body: 'hello' }),
				}),
			},
		});

		const result = await executeRun([entry], {
			actionPath: 'notes.notes',
			input: { body: 'hello' },
			waitMs: 25,
		});

		expect(result.error?.name).toBe('UsageError');
		if (result.error?.name !== 'UsageError') {
			throw new Error('expected UsageError');
		}
		expect(result.error.suggestions).toEqual(['  notes.notes_add  (mutation)']);
	});

	test('unknown route returns available route suggestions', async () => {
		const result = await executeRun(
			[fakeEntry({}), fakeEntry({ route: 'tasks', actions: {} })],
			{
				actionPath: 'missing.actions_add',
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
