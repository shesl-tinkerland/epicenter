/**
 * Coverage for the `/list` route. Exercises the route via `app.request`
 * against an in-memory Hono app, no unix socket spun up. The wire shape
 * round-trips through serialization the same way the daemonClient sees
 * it, so this is the load-bearing test surface for list dispatch logic.
 *
 * `/list` is now a one-primitive route: `describeActions(workspace.actions)`.
 * No modes, no peer waits, no fan-out. Per-peer schema introspection lives
 * on `/peers` (and `peers <deviceId>` on the CLI).
 */

import { describe, expect, test } from 'bun:test';
import { defineQuery } from '@epicenter/workspace';

import type { ListResult } from '../commands/list';
import type { LoadedWorkspace, WorkspaceEntry } from '../load-config';
import { buildApp } from './app';

function fakeEntry(
	name: string,
	actions?: Record<string, unknown>,
): WorkspaceEntry {
	const workspace: LoadedWorkspace = {
		whenReady: Promise.resolve(),
		actions: actions as LoadedWorkspace['actions'],
		[Symbol.dispose]() {},
	};
	return { name, workspace } as WorkspaceEntry;
}

async function postList(
	entry: WorkspaceEntry,
	body: unknown,
): Promise<ListResult> {
	const app = buildApp([entry]);
	const res = await app.request('/list', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body),
	});
	return res.json();
}

describe('/list route', () => {
	test('returns describeActions output for the resolved workspace', async () => {
		const reply = await postList(
			fakeEntry('demo', {
				counter: {
					get: defineQuery({
						description: 'Read the counter',
						handler: () => 0,
					}),
				},
			}),
			{},
		);
		expect(reply.error).toBeNull();
		if (reply.error === null) {
			expect(Object.keys(reply.data).sort()).toEqual(['counter.get']);
			expect(reply.data['counter.get']?.description).toBe('Read the counter');
		}
	});

	test('returns an empty manifest when the workspace has no actions', async () => {
		const reply = await postList(fakeEntry('demo'), {});
		expect(reply.error).toBeNull();
		if (reply.error === null) {
			expect(reply.data).toEqual({});
		}
	});
});
