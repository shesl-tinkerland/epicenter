/**
 * Daemon `/run` handler tests.
 *
 * One entry point, two execution targets: `peer` absent runs locally against
 * this daemon's registry, `peer` present dispatches to it. The relay owns
 * reachability: a `RecipientOffline` dispatch error surfaces as
 * `PeerNotFound`, every other dispatch error as `RemoteCallFailed`. The
 * `collab.dispatch` path is faked here so the test can drive those outcomes
 * without spinning up real Yjs sync.
 */

import { describe, expect, test } from 'bun:test';
import Type from 'typebox';
import type { Result } from 'wellcrafted/result';
import { expectErr, expectOk } from 'wellcrafted/testing';

import { DispatchError, type DispatchRequest } from '../document/dispatch.js';
import type { SyncStatus } from '../document/internal/sync-supervisor.js';
import type { ActionRegistry } from '../shared/actions.js';
import { defineMutation, defineQuery } from '../shared/actions.js';
import type { PeerSyncStatus } from './action-errors.js';
import { executeRun } from './action-handler.js';
import type { DaemonServedMount } from './types.js';

type FakeDispatch = <TOutput = unknown>(
	req: DispatchRequest,
) => Promise<Result<TOutput, DispatchError>>;

function fakeEntry({
	mount = 'demo',
	actions = {
		tabs_list: defineQuery({ handler: () => [] }),
	},
	syncStatus = { phase: 'connected' },
	dispatch = (async () => ({ data: null, error: null })) as FakeDispatch,
}: {
	mount?: string;
	actions?: ActionRegistry;
	syncStatus?: SyncStatus;
	dispatch?: FakeDispatch;
} = {}): DaemonServedMount {
	return {
		mount,
		runtime: {
			collaboration: {
				actions,
				status: syncStatus,
				devices: {
					list: () => [],
				},
				dispatch,
			},
		},
	};
}

describe('executeRun peer target', () => {
	test('rejects invalid wait budgets before creating an AbortSignal', async () => {
		const result = await executeRun([fakeEntry({})], {
			actionPath: 'demo.tabs_list',
			input: undefined,
			peer: { to: 'mac', waitMs: -1 },
		});

		const error = expectErr(result);
		expect(error.name).toBe('UsageError');
		if (error.name !== 'UsageError') {
			throw new Error(`expected UsageError, got ${error.name}`);
		}
		expect(error.message).toBe('`waitMs` must be a non-negative integer.');
	});

	test('relay RecipientOffline surfaces as PeerNotFound with sync status', async () => {
		const syncStatus = {
			phase: 'connecting',
			retries: 2,
			lastError: { type: 'connection' },
		} as const satisfies SyncStatus;
		const runSyncStatus = {
			phase: 'connecting',
			retries: 2,
			lastErrorType: 'connection',
		} satisfies PeerSyncStatus;
		const entry = fakeEntry({
			syncStatus,
			dispatch: (async () =>
				DispatchError.RecipientOffline({ to: 'ghost' })) as FakeDispatch,
		});

		const result = await executeRun([entry], {
			actionPath: 'demo.tabs_list',
			input: undefined,
			peer: { to: 'ghost', waitMs: 25 },
		});

		const error = expectErr(result);
		expect(error.name).toBe('PeerNotFound');
		if (error.name !== 'PeerNotFound') {
			throw new Error(`expected PeerNotFound, got ${error.name}`);
		}
		expect(error.to).toBe('ghost');
		expect(error.syncStatus).toEqual(runSyncStatus);
	});

	test('remote dispatch sends the resolved deviceId and action key', async () => {
		let invokedAction = '';
		let invokedTo = '';
		const entry = fakeEntry({
			dispatch: (async (req) => {
				invokedAction = req.action;
				invokedTo = req.to;
				return { data: [], error: null };
			}) as FakeDispatch,
		});

		const result = await executeRun([entry], {
			actionPath: 'demo.tabs_list',
			input: undefined,
			peer: { to: 'mac', waitMs: 25 },
		});

		expectOk(result);
		expect(invokedAction).toBe('tabs_list');
		expect(invokedTo).toBe('mac');
	});

	test('non-offline DispatchError surfaces as RemoteCallFailed', async () => {
		const entry = fakeEntry({
			dispatch: (async () =>
				DispatchError.ActionFailed({
					action: 'tabs_list',
					cause: 'boom',
				})) as FakeDispatch,
		});

		const result = await executeRun([entry], {
			actionPath: 'demo.tabs_list',
			input: undefined,
			peer: { to: 'mac', waitMs: 25 },
		});

		const error = expectErr(result);
		expect(error.name).toBe('RemoteCallFailed');
		if (error.name !== 'RemoteCallFailed') {
			throw new Error('expected RemoteCallFailed');
		}
		expect(error.cause).toMatchObject({ name: 'ActionFailed' });
	});

	test('recipient owns action existence for peer dispatch', async () => {
		let invokedAction = '';
		const entry = fakeEntry({
			actions: {},
			dispatch: (async (req) => {
				invokedAction = req.action;
				return { data: 'ok', error: null };
			}) as FakeDispatch,
		});

		const result = await executeRun([entry], {
			actionPath: 'demo.peer_only_action',
			input: undefined,
			peer: { to: 'mac', waitMs: 25 },
		});

		expectOk(result);
		expect(invokedAction).toBe('peer_only_action');
	});
});

describe('executeRun mount-prefixed routing', () => {
	test('invokes action under the selected mount', async () => {
		const entry = fakeEntry({
			mount: 'notes',
			actions: {
				notes_add: defineMutation({
					handler: () => ({ body: 'hello' }),
				}),
			},
		});

		const result = await executeRun([entry], {
			actionPath: 'notes.notes_add',
			input: { body: 'hello' },
		});

		const data = expectOk(result);
		expect(data).toEqual({ body: 'hello' });
	});

	test('missing prefix suggests action-root-relative sibling', async () => {
		const entry = fakeEntry({
			mount: 'notes',
			actions: {
				notes_add: defineMutation({
					handler: () => ({ body: 'hello' }),
				}),
			},
		});

		const result = await executeRun([entry], {
			actionPath: 'notes.notes',
			input: { body: 'hello' },
		});

		const error = expectErr(result);
		expect(error.name).toBe('UsageError');
		if (error.name !== 'UsageError') {
			throw new Error('expected UsageError');
		}
		expect(error.suggestions).toEqual(['  notes.notes_add  (mutation)']);
	});

	test('unknown mount returns available mount suggestions', async () => {
		const result = await executeRun(
			[fakeEntry({}), fakeEntry({ mount: 'tasks', actions: {} })],
			{
				actionPath: 'missing.actions_add',
				input: undefined,
			},
		);

		const error = expectErr(result);
		expect(error.name).toBe('UsageError');
		if (error.name !== 'UsageError') {
			throw new Error('expected UsageError');
		}
		expect(error.message).toBe('No mount "missing". Available: demo, tasks');
		expect(error.suggestions).toEqual(['  demo', '  tasks']);
	});

	test('input failing the action schema surfaces as UsageError, not RuntimeError', async () => {
		const entry = fakeEntry({
			mount: 'fuji',
			actions: {
				bulk_delete: defineMutation({
					input: Type.Object({ maxDeletes: Type.Optional(Type.Number()) }),
					handler: (input) => ({ maxDeletes: input.maxDeletes ?? 10 }),
				}),
			},
		});

		const result = await executeRun([entry], {
			actionPath: 'fuji.bulk_delete',
			input: { maxDeletes: 'lots' },
		});

		const error = expectErr(result);
		// A bad input is the caller's mistake (exit 1), not a handler crash (exit 2).
		expect(error.name).toBe('UsageError');
		expect(error.message).toContain('maxDeletes');
	});
});
