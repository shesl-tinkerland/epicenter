/**
 * Smoke tests for `buildRemoteWorkspace`. Uses a stub `DaemonClient` that
 * records every call rather than touching a real socket: the runtime
 * Proxy machinery is what we're verifying, not transport.
 */

import { describe, expect, test } from 'bun:test';
import { Ok } from 'wellcrafted/result';

import { buildRemoteWorkspace } from './remote.js';
import type { DaemonClient } from '../daemon/client.js';
import type { RunInput } from '../daemon/app.js';

function makeStubClient() {
	const calls: { method: 'run' | 'peers' | 'list'; arg: unknown }[] = [];
	const client: DaemonClient = {
		peers: () => {
			calls.push({ method: 'peers', arg: undefined });
			return Promise.resolve(Ok([])) as ReturnType<DaemonClient['peers']>;
		},
		list: (input) => {
			calls.push({ method: 'list', arg: input });
			return Promise.resolve(Ok({})) as ReturnType<DaemonClient['list']>;
		},
		run: (input: RunInput) => {
			calls.push({ method: 'run', arg: input });
			return Promise.resolve(Ok(null)) as ReturnType<DaemonClient['run']>;
		},
	};
	return { client, calls };
}

const WORKSPACE = 'demo';

describe('buildRemoteWorkspace tables', () => {
	test('tables.X.get dispatches tables.X.get over /run', async () => {
		const { client, calls } = makeStubClient();
		// biome-ignore lint/suspicious/noExplicitAny: smoke test: shape is irrelevant
		const ws: any = buildRemoteWorkspace(client, WORKSPACE);

		await ws.tables.entries.get('xyz');

		expect(calls).toHaveLength(1);
		expect(calls[0]!.method).toBe('run');
		expect(calls[0]!.arg).toMatchObject({
			workspace: WORKSPACE,
			actionPath: 'tables.entries.get',
			input: 'xyz',
		});
	});

	test('tables.X.set dispatches with the row as input', async () => {
		const { client, calls } = makeStubClient();
		// biome-ignore lint/suspicious/noExplicitAny: smoke test
		const ws: any = buildRemoteWorkspace(client, WORKSPACE);
		const row = { id: 'a', title: 'hi', _v: 1 };

		await ws.tables.entries.set(row);

		expect(calls[0]!.arg).toMatchObject({
			actionPath: 'tables.entries.set',
			input: row,
		});
	});

	test('tables.X.update dispatches the patch object as input', async () => {
		const { client, calls } = makeStubClient();
		// biome-ignore lint/suspicious/noExplicitAny: smoke test
		const ws: any = buildRemoteWorkspace(client, WORKSPACE);

		await ws.tables.entries.update({ id: 'a', title: 'changed' });

		expect(calls[0]!.arg).toMatchObject({
			actionPath: 'tables.entries.update',
			input: { id: 'a', title: 'changed' },
		});
	});
});

describe('buildRemoteWorkspace nested actions', () => {
	test('top-level branded leaves dispatch by name', async () => {
		const { client, calls } = makeStubClient();
		// biome-ignore lint/suspicious/noExplicitAny: smoke test
		const ws: any = buildRemoteWorkspace(client, WORKSPACE);

		await ws.savedTabs.list({});

		expect(calls).toHaveLength(1);
		expect(calls[0]!.arg).toMatchObject({
			workspace: WORKSPACE,
			actionPath: 'savedTabs.list',
			input: {},
		});
	});

	test('deeply nested actions traverse and join with .', async () => {
		const { client, calls } = makeStubClient();
		// biome-ignore lint/suspicious/noExplicitAny: smoke test
		const ws: any = buildRemoteWorkspace(client, WORKSPACE);

		await ws.deeply.nested.action({ x: 1 });

		expect(calls[0]!.arg).toMatchObject({
			actionPath: 'deeply.nested.action',
			input: { x: 1 },
		});
	});

	test('action with no input sends undefined', async () => {
		const { client, calls } = makeStubClient();
		// biome-ignore lint/suspicious/noExplicitAny: smoke test
		const ws: any = buildRemoteWorkspace(client, WORKSPACE);

		await ws.system.describe();

		expect(calls[0]!.arg).toMatchObject({
			actionPath: 'system.describe',
			input: undefined,
		});
	});

	test('intermediate namespace access does not dispatch', async () => {
		const { client, calls } = makeStubClient();
		// biome-ignore lint/suspicious/noExplicitAny: smoke test
		const ws: any = buildRemoteWorkspace(client, WORKSPACE);

		// Just walking the chain should issue zero RPCs.
		const namespace = ws.deeply.nested;
		expect(calls).toHaveLength(0);

		await namespace.action({});
		expect(calls).toHaveLength(1);
	});
});
