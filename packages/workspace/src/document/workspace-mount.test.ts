/**
 * `definition.mount(...)` coordinator tests.
 *
 * `.mount()` is a pure coordinator over an injected node runtime, so these
 * tests inject a stub `NodeMountRuntime` and assert what the coordinator hands
 * the runtime: the resolved base URL, the *composed* action set (never the base
 * actions when `compose` selects others), and the materializer list drained on
 * teardown. No node:* or bun:* modules are touched.
 */

import { describe, expect, test } from 'bun:test';
import { field } from '@epicenter/field';
import * as Y from 'yjs';
import type { SessionMountContext } from '../daemon/define-mount.js';
import type { NodeMountRuntime } from '../daemon/mount-runtime.js';
import { defineActions, defineQuery } from '../shared/actions.js';
import type { AgentId } from './agent-id.js';
import { attachKvStore } from './attach-kv-store.js';
import type { ConnectedChildDoc } from './child-doc-worker.js';
import { defineTable } from './define-table.js';
import { defineWorkspace } from './workspace.js';

const demoWorkspace = defineWorkspace({
	id: 'epicenter-demo',
	name: 'demo',
	tables: {
		items: defineTable({ id: field.string(), label: field.string() }),
		conversations: defineTable({
			id: field.string(),
			title: field.string(),
			// Designation: the worker loop hosts only rows bound to the agent the
			// daemon answers as (the mount's `agentId`).
			agent: field.string<AgentId>(),
		}).docs({
			messages: (ydoc: Y.Doc) => attachKvStore<{ id: string }>(ydoc),
		}),
	},
	kv: {},
	actions: ({ tables }) =>
		defineActions({
			items_count: defineQuery({
				description: 'Count items',
				handler: () => tables.items.storedCount(),
			}),
		}),
});

/** What the stub `attachInfrastructure` captured from the coordinator. */
type AttachSpy = {
	baseURL?: string;
	actions?: Record<string, unknown>;
	materializers?: ReadonlyArray<{ whenDisposed: Promise<void> }>;
	/** Guids the stub `connectChildDoc` connector was asked to open. */
	childDocGuids: string[];
};

/**
 * A stub node runtime: `defineSessionMount` passes through (so the test calls
 * `open(ctx)` directly), and `attachInfrastructure` records its options instead
 * of touching disk or sockets. The materializer helpers return fixed
 * single-action registries so the merge is observable.
 */
function stubRuntime(spy: AttachSpy): NodeMountRuntime {
	return {
		defineSessionMount: (mount: {
			name: string;
			open: (c: SessionMountContext) => unknown;
		}) => ({ name: mount.name, open: mount.open }),
		resolveBaseURL: (explicit?: string) => explicit ?? 'https://hosted.example',
		// In-memory child-doc connector: record each requested guid and return a
		// body whose teardown cascades off `ydoc.destroy()`. No disk, no sockets.
		connectChildDoc:
			(_ctx: SessionMountContext, _baseURL: string) =>
			(guid: string): ConnectedChildDoc => {
				spy.childDocGuids.push(guid);
				const ydoc = new Y.Doc({ guid, gc: true });
				const { promise: whenDisposed, resolve } =
					Promise.withResolvers<void>();
				ydoc.once('destroy', () => resolve());
				return {
					ydoc,
					whenDisposed,
					dispose() {
						ydoc.destroy();
					},
				};
			},
		attachInfrastructure: (
			ydoc: { destroy(): void },
			_ctx: SessionMountContext,
			opts: {
				baseURL: string;
				actions: Record<string, unknown>;
				materializers?: ReadonlyArray<{ whenDisposed: Promise<void> }>;
			},
		) => {
			spy.baseURL = opts.baseURL;
			spy.actions = opts.actions;
			spy.materializers = opts.materializers;
			return {
				actions: opts.actions,
				yjsLog: { whenDisposed: Promise.resolve() },
				collaboration: { whenDisposed: Promise.resolve() },
				async [Symbol.asyncDispose]() {
					ydoc.destroy();
				},
			};
		},
		// The stub is intentionally looser than the real runtime types.
	} as unknown as NodeMountRuntime;
}

/** A stub session context; the coordinator only forwards it. */
const ctx = {
	epicenterRoot: '/tmp/epicenter-root',
	mount: 'demo',
	nodeId: 'node-fixture',
	session: {
		ownerId: 'owner-fixture',
		openWebSocket: () => {},
		onReconnectSignal: () => () => {},
		fetch: async () => new Response(),
	},
} as unknown as SessionMountContext;

// biome-ignore lint/suspicious/noExplicitAny: the coordinator return is a daemon runtime read structurally here.
const open = (mount: { open: (c: SessionMountContext) => unknown }): any =>
	mount.open(ctx);

describe('definition.mount', () => {
	test('without compose: serves base actions, no materializers, falls back to hosted URL', () => {
		const spy: AttachSpy = { childDocGuids: [] };
		const mount = demoWorkspace.mount({
			runtime: stubRuntime(spy),
		});

		// The mount label is the definition's `name`, not a per-mount field.
		expect(mount.name).toBe('demo');
		const runtime = open(mount);

		expect(spy.baseURL).toBe('https://hosted.example');
		expect(Object.keys(spy.actions ?? {})).toEqual(['items_count']);
		expect(spy.materializers).toEqual([]);
		expect(runtime.actions).toBe(spy.actions);
		expect(typeof runtime[Symbol.asyncDispose]).toBe('function');
	});

	test('with compose: serves the composed action set, tracks materializers', () => {
		const spy: AttachSpy = { childDocGuids: [] };
		const mount = demoWorkspace.mount({
			baseURL: 'https://explicit.example',
			runtime: stubRuntime(spy),
			compose: ({ workspace, scope }) => {
				// The real body would call `attachMountSqlite` / `attachMountMarkdown`
				// here, which enroll their own drain through `scope.registerDrain`.
				// Stub them as drainables with one-action registries and register them
				// by hand, so both the merge into the served set and the coordinator's
				// drain collection are observable without touching disk. Note the
				// return carries `actions` only: the materializers reach teardown
				// purely through registration, never through the returned object.
				const rebuild = defineQuery({
					description: 'rebuild',
					handler: () => null,
				});
				const sqlite = {
					whenDisposed: Promise.resolve(),
					actions: { sqlite_rebuild: rebuild },
				};
				const markdown = {
					whenDisposed: Promise.resolve(),
					actions: { markdown_rebuild: rebuild },
				};
				scope.registerDrain(sqlite);
				scope.registerDrain(markdown);
				return {
					actions: defineActions({
						...workspace.actions,
						...sqlite.actions,
						...markdown.actions,
					}),
				};
			},
		});

		const runtime = open(mount);

		// The explicit base URL wins over the env/hosted fallback.
		expect(spy.baseURL).toBe('https://explicit.example');
		// The served set is the composed one: base + both materializers.
		expect(Object.keys(spy.actions ?? {}).sort()).toEqual([
			'items_count',
			'markdown_rebuild',
			'sqlite_rebuild',
		]);
		// Both materializers are listed for ordered teardown.
		expect(spy.materializers).toHaveLength(2);
		// The runtime serves exactly what infrastructure was handed.
		expect(runtime.actions).toBe(spy.actions);
	});

	test('with workers: hosts child docs at the schema-derived guid, drains the worker', () => {
		const spy: AttachSpy = { childDocGuids: [] };
		const mount = demoWorkspace.mount({
			runtime: stubRuntime(spy),
			// This daemon answers as the `daemon-agent` agent.
			agentId: 'daemon-agent' as AgentId,
			workers: {
				// The app registers behavior only: no table, guid, or layout passed.
				conversations: { messages: () => ({}) },
			},
		});

		const runtime = open(mount);

		// The worker is registered for ordered teardown even before any row exists.
		expect(spy.materializers).toHaveLength(1);

		// A row bound to this daemon's agent drives the loop to host its transcript
		// at the guid the schema derives, the same address the browser opener uses.
		runtime.tables.conversations.set({
			id: 'c1',
			title: 'first',
			agent: 'daemon-agent' as AgentId,
		});
		const expectedGuid = runtime.tables.conversations.docs.messages.guid('c1');
		expect(spy.childDocGuids).toEqual([expectedGuid]);

		// A row bound to a different agent (the cloud agent) is NOT this daemon's to
		// answer, so the loop never hosts it: that filter is the daemon half of the
		// D3 fix.
		runtime.tables.conversations.set({
			id: 'c2',
			title: 'second',
			agent: 'epicenter-cloud' as AgentId,
		});
		expect(spy.childDocGuids).toEqual([expectedGuid]);
	});
});
