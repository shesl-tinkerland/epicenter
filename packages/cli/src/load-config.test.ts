import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AuthClient } from '@epicenter/auth';
import {
	CONFIG_FILENAME,
	loadDaemonConfig,
	startDaemonRoutes,
} from './load-config';

let workDir: string;
const daemonModuleUrl = pathToFileURL(
	join(import.meta.dir, '../../workspace/src/daemon/index.ts'),
).href;

beforeEach(() => {
	workDir = mkdtempSync(join(tmpdir(), 'ep-load-config-'));
	delete (globalThis as { __loadConfigEvents?: string[] }).__loadConfigEvents;
});

afterEach(() => {
	rmSync(workDir, { recursive: true, force: true });
	delete (globalThis as { __loadConfigEvents?: string[] }).__loadConfigEvents;
});

function writeConfig(source: string) {
	writeFileSync(join(workDir, CONFIG_FILENAME), source);
}

const daemonTransportFields = `
	collaboration: {
		actions: {},
		peers: {
			list: () => [],
			find: () => undefined,
			observe: () => () => {}
		},
		onStatusChange: () => () => {}
	},
`;

function fakeAuthClient(): AuthClient {
	return {
		state: { status: 'signed-out' },
		onStateChange: () => () => undefined,
		startSignIn: async () => ({ data: undefined, error: null }),
		signOut: async () => ({ data: undefined, error: null }),
		fetch: globalThis.fetch.bind(globalThis),
		openWebSocket: async (url, protocols) => new WebSocket(url, protocols),
		[Symbol.dispose]() {},
	};
}

describe('loadDaemonConfig', () => {
	test('loads helper config without starting route definitions', async () => {
		writeConfig(`
			import { defineConfig } from '${daemonModuleUrl}';
			globalThis.__loadConfigEvents = [];

			export default defineConfig({
				daemon: {
					routes: [{
						route: 'demo',
						start: ({ auth, projectDir, route }) => {
							globalThis.__loadConfigEvents.push('started');
							return {
								collaboration: {
									actions: {
										paths_auth_status: { handler: () => auth.state.status },
										paths_project_dir: { handler: () => projectDir },
										paths_route: { handler: () => route }
									},
									peers: {
										list: () => [],
										find: () => undefined,
										observe: () => () => {}
									},
									onStatusChange: () => () => {}
								},
								async [Symbol.asyncDispose]() {}
							};
						}
					}]
				}
			});
		`);

		const loaded = await loadDaemonConfig(workDir);

		expect(loaded.error).toBeNull();
		expect(loaded.data?.routes.map((entry) => entry.route)).toEqual(['demo']);
		expect(
			(globalThis as { __loadConfigEvents?: string[] }).__loadConfigEvents,
		).toEqual([]);

		if (loaded.error !== null) return;
		const started = await startDaemonRoutes(loaded.data, {
			auth: fakeAuthClient(),
		});

		expect(started.error).toBeNull();
		expect(started.data?.map((entry) => entry.route)).toEqual(['demo']);
		const actions = started.data?.[0]?.runtime.collaboration.actions as
			| Record<string, { handler(): string }>
			| undefined;
		expect(actions?.paths_project_dir?.handler()).toBe(workDir);
		expect(actions?.paths_route?.handler()).toBe('demo');
		expect(actions?.paths_auth_status?.handler()).toBe('signed-out');
		expect(
			(globalThis as { __loadConfigEvents?: string[] }).__loadConfigEvents,
		).toEqual(['started']);
	});

	test('rejects invalid route keys before starting route definitions', async () => {
		writeConfig(`
			globalThis.__loadConfigEvents = [];

			export default {
				daemon: {
					routes: [{
						route: 'bad.route',
						start: () => {
							globalThis.__loadConfigEvents.push('started');
							throw new Error('invalid route definition started');
						}
					}]
				}
			};
		`);

		const result = await loadDaemonConfig(workDir);

		expect(result.data).toBeNull();
		expect(result.error?.name).toBe('InvalidRoute');
		expect(
			(globalThis as { __loadConfigEvents?: string[] }).__loadConfigEvents,
		).toEqual([]);
	});

	test('rejects reserved object route keys before starting route definitions', async () => {
		writeConfig(`
			globalThis.__loadConfigEvents = [];

			export default {
				daemon: {
					routes: [{
						route: 'constructor',
						start: () => {
							globalThis.__loadConfigEvents.push('started');
							throw new Error('reserved route definition started');
						}
					}]
				}
			};
		`);

		const result = await loadDaemonConfig(workDir);

		expect(result.data).toBeNull();
		expect(result.error?.name).toBe('InvalidRoute');
		expect(
			(globalThis as { __loadConfigEvents?: string[] }).__loadConfigEvents,
		).toEqual([]);
	});

	test('rejects duplicate route definitions', async () => {
		writeConfig(`
			export default {
				daemon: {
					routes: [
						{ route: 'demo', start: () => ({}) },
						{ route: 'demo', start: () => ({}) }
					]
				}
			};
		`);

		const result = await loadDaemonConfig(workDir);

		expect(result.data).toBeNull();
		expect(result.error?.name).toBe('DuplicateRoute');
	});

	test('loads structural async daemon route config without helper', async () => {
		writeConfig(`
			export default {
				daemon: {
					routes: [{
						route: 'demo',
						start: () => Promise.resolve({
							${daemonTransportFields}
							async [Symbol.asyncDispose]() {}
						})
					}]
				}
			};
		`);

		const loaded = await loadDaemonConfig(workDir);
		expect(loaded.error).toBeNull();
		if (loaded.error !== null) return;

		const auth = fakeAuthClient();
		const started = await startDaemonRoutes(loaded.data, { auth });
		expect(started.error).toBeNull();
		expect(started.data?.[0]?.route).toBe('demo');
	});

	test('rejects invalid route definitions', async () => {
		writeConfig(`
			export default {
				daemon: {
					routes: [{ route: 'demo' }]
				}
			};
		`);

		const result = await loadDaemonConfig(workDir);

		expect(result.data).toBeNull();
		expect(result.error?.name).toBe('InvalidRouteDefinition');
	});

	test('rejects route runtimes missing daemon contract fields', async () => {
		writeConfig(`
			export default {
				daemon: {
					routes: [{
						route: 'demo',
						start: () => ({
							actions: {}
						})
					}]
				}
			};
		`);

		const loaded = await loadDaemonConfig(workDir);
		expect(loaded.error).toBeNull();
		if (loaded.error !== null) return;

		const started = await startDaemonRoutes(loaded.data, {
			auth: fakeAuthClient(),
		});
		expect(started.data).toBeNull();
		expect(started.error?.name).toBe('InvalidRouteRuntime');
	});

	test('accepts route runtimes without unused CLI fields', async () => {
		writeConfig(`
			export default {
				daemon: {
					routes: [{
						route: 'demo',
						start: () => ({
							${daemonTransportFields}
							async [Symbol.asyncDispose]() {}
						})
					}]
				}
			};
		`);

		const loaded = await loadDaemonConfig(workDir);
		expect(loaded.error).toBeNull();
		if (loaded.error !== null) return;

		const started = await startDaemonRoutes(loaded.data, {
			auth: fakeAuthClient(),
		});
		expect(started.error).toBeNull();
		expect(started.data?.[0]?.route).toBe('demo');
	});

	test('cleans up resolved runtimes when a later route rejects', async () => {
		writeConfig(`
			globalThis.__loadConfigEvents = [];

			export default {
				daemon: {
					routes: [
						{
							route: 'first',
							start: () => ({
								${daemonTransportFields}
								async [Symbol.asyncDispose]() {
									globalThis.__loadConfigEvents.push('disposed:first');
								}
							})
						},
						{
							route: 'second',
							start: () => Promise.reject(new Error('boom'))
						}
					]
				}
			};
		`);

		const loaded = await loadDaemonConfig(workDir);
		expect(loaded.error).toBeNull();
		if (loaded.error !== null) return;

		const started = await startDaemonRoutes(loaded.data, {
			auth: fakeAuthClient(),
		});

		expect(started.data).toBeNull();
		expect(started.error?.name).toBe('RouteFailed');
		expect(
			(globalThis as { __loadConfigEvents?: string[] }).__loadConfigEvents,
		).toEqual(['disposed:first']);
	});

	test('rejects missing default config', async () => {
		writeConfig(`
			export const demo = {
				route: 'demo',
				actions: {},
				async [Symbol.asyncDispose]() {}
			};
		`);

		const result = await loadDaemonConfig(workDir);

		expect(result.data).toBeNull();
		expect(result.error?.name).toBe('InvalidConfig');
	});
});
