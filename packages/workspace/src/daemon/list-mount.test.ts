/**
 * Coverage for the `/list` manifest projection.
 *
 * `/list` describes every hosted mount and prefixes each action key with the
 * mount name. The shared action path helpers are covered here because `/list`
 * and `/run` both rely on the same mount qualifier rules.
 */

import { describe, expect, test } from 'bun:test';
import type { Result } from 'wellcrafted/result';
import { expectOk } from 'wellcrafted/testing';
import { type ActionManifest, defineQuery } from '../shared/actions.js';
import { joinDaemonActionPath, parseDaemonActionPath } from './action-path.js';
import { buildDaemonApp } from './app.js';
import type { DaemonServedMount } from './types.js';

function makeMount({
	mount,
	actions,
}: {
	mount: string;
	actions: DaemonServedMount['runtime']['collaboration']['actions'];
}): DaemonServedMount {
	return {
		mount,
		runtime: {
			collaboration: {
				actions,
				devices: {
					list: () => [],
				},
				status: { phase: 'connected' },
				dispatch: async () => ({ data: null, error: null }) as never,
			},
		},
	};
}

describe('daemon action path helpers', () => {
	test('joinDaemonActionPath prefixes local action paths with the mount', () => {
		expect(joinDaemonActionPath('demo', 'counter_get')).toBe(
			'demo.counter_get',
		);
	});

	test('parseDaemonActionPath separates the mount from the local action path', () => {
		expect(parseDaemonActionPath('demo.counter_get')).toEqual({
			mount: 'demo',
			localPath: 'counter_get',
		});
	});

	test('parseDaemonActionPath preserves invalid dotted action suffixes', () => {
		expect(parseDaemonActionPath('demo.counter.get')).toEqual({
			mount: 'demo',
			localPath: 'counter.get',
		});
	});
});

describe('/list route', () => {
	test('returns mount-prefixed paths under the action root', async () => {
		const res = await buildDaemonApp([
			makeMount({
				mount: 'demo',
				actions: {
					counter_get: defineQuery({
						description: 'Read the counter',
						handler: () => 0,
					}),
				},
			}),
		]).request('/list', { method: 'POST' });

		const manifest = expectOk(
			(await res.json()) as Result<ActionManifest, never>,
		);
		expect(Object.keys(manifest).sort()).toEqual(['demo.counter_get']);
		expect(manifest['demo.counter_get']?.description).toBe('Read the counter');
	});

	test('returns an empty manifest when the collaboration has no actions', async () => {
		const res = await buildDaemonApp([
			makeMount({ mount: 'demo', actions: {} }),
		]).request('/list', { method: 'POST' });

		const manifest = expectOk(
			(await res.json()) as Result<ActionManifest, never>,
		);
		expect(manifest).toEqual({});
	});

	test('prefixes actions from every mount', async () => {
		const res = await buildDaemonApp([
			makeMount({
				mount: 'notes',
				actions: {
					notes_add: defineQuery({ handler: () => null }),
				},
			}),
			makeMount({
				mount: 'tasks',
				actions: {
					tasks_list: defineQuery({ handler: () => [] }),
				},
			}),
		]).request('/list', { method: 'POST' });

		const manifest = expectOk(
			(await res.json()) as Result<ActionManifest, never>,
		);
		expect(Object.keys(manifest).sort()).toEqual([
			'notes.notes_add',
			'tasks.tasks_list',
		]);
	});
});
