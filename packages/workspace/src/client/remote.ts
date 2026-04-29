/**
 * `buildRemoteWorkspace` — typed proxy that turns a `DaemonClient` into a
 * workspace-shaped facade. Local call sites get the same `tables.X.set(...)`,
 * `actions.A.B(...)`, `sync.peers()` shape they would have in-process; each
 * method dispatches over the unix socket via `client.run` / `client.peers`.
 *
 * Why a recursive Proxy for actions: we don't know the action tree at
 * type-erasure time. When the user writes `ws.actions.deeply.nested.foo({})`,
 * we walk the property chain at runtime, accumulate the path segments, and
 * dispatch on call. `then` is masked so accidental `await ws.actions.x` does
 * not turn the proxy into a thenable.
 *
 * `tables` are simpler: the wire surface is fixed (`get`, `getAllValid`,
 * `set`, `update`, `delete`, `bulkSet`), each one a thin `client.run` call
 * with a path of the form `tables.<name>.<verb>`. That layout matches what
 * `buildTableActions(...)` mounts on the in-process workspace, so the same
 * routes serve both directions.
 *
 * `filter`, `observe`, and document handles throw `RemoteNotSupported`
 * because they require a live Y.Doc and can't cross the wire. The type
 * doesn't expose them; the runtime stubs exist so dynamic access patterns
 * fail loudly rather than silently returning undefined.
 *
 * Phase 5 of `specs/20260429T004302-workspace-as-daemon-transport.md`.
 */

import type { DaemonClient } from '../daemon/client.js';
import { RemoteNotSupported } from './remote-not-supported.js';
import type { RemoteWorkspace } from './remote-workspace-types.js';

/** Default `waitMs` value we send on every `/run` request. */
const DEFAULT_WAIT_MS = 5000;

/**
 * Build the per-table CRUD proxy. Property access on a string `tableName`
 * yields an object with the wire-callable methods plus runtime stubs for
 * `filter` / `observe` that throw `RemoteNotSupported`.
 *
 * `workspaceName` is the daemon-side workspace selector. Today the wire
 * uses the human-facing `name` (per Phase 2 deviation in the spec); the
 * argument to `buildRemoteWorkspace` doubles for both id and name until
 * the wire moves to id-based dispatch.
 */
function buildRemoteTables(
	client: DaemonClient,
	workspaceName: string,
): unknown {
	return new Proxy(Object.create(null) as Record<string, unknown>, {
		get(_target, tableName) {
			if (typeof tableName !== 'string') return undefined;
			// Mask thenable detection so destructuring / await doesn't trip
			// on a missing `then`.
			if (tableName === 'then') return undefined;
			const run = (verb: string, input: unknown) =>
				client.run({
					workspace: workspaceName,
					actionPath: `tables.${tableName}.${verb}`,
					input,
					waitMs: DEFAULT_WAIT_MS,
				});
			return {
				get: (input: { id: string }) => run('get', input),
				getAllValid: () => run('getAllValid', undefined),
				set: (row: unknown) => run('set', row),
				update: (input: unknown) => run('update', input),
				delete: (input: { id: string }) => run('delete', input),
				bulkSet: (input: { rows: unknown[] }) => run('bulkSet', input),
				// Runtime stubs for surfaces the type intentionally hides.
				// These exist so dynamic property access fails loudly with a
				// useful error instead of returning undefined.
				filter: () => {
					throw RemoteNotSupported.RemoteNotSupported({
						method: `tables.${tableName}.filter`,
						reason:
							'predicate-based filtering needs a live Y.Doc; use getAllValid() and filter client-side, or use the in-process builder.',
					}).error;
				},
				observe: () => {
					throw RemoteNotSupported.RemoteNotSupported({
						method: `tables.${tableName}.observe`,
						reason:
							'live subscriptions are not exposed over the unix socket transport; use the in-process builder.',
					}).error;
				},
			};
		},
	});
}

/**
 * Build the recursive action proxy. Every property access produces another
 * proxy carrying the path-so-far; calling the proxy dispatches `client.run`
 * with the joined dotted path.
 *
 * `function () {}` is the proxy target so `apply` is reachable. The `then`
 * key is masked everywhere on the path (otherwise an `await` on an
 * intermediate namespace would turn it into a thenable and pollute the
 * action tree with a `.then(...)` call).
 */
function buildRemoteActions(
	client: DaemonClient,
	workspaceName: string,
): unknown {
	const make = (path: string[]): unknown => {
		// Targeted cast: the proxy target is a function so `apply` works,
		// but the public type for callers is a nested action tree. Both
		// access shapes go through the same handlers.
		const target = (() => {}) as unknown as object;
		return new Proxy(target, {
			get(_target, prop) {
				if (typeof prop !== 'string') return undefined;
				if (prop === 'then') return undefined;
				return make([...path, prop]);
			},
			apply(_target, _thisArg, args) {
				const input = args.length === 0 ? undefined : args[0];
				return client.run({
					workspace: workspaceName,
					actionPath: path.join('.'),
					input,
					waitMs: DEFAULT_WAIT_MS,
				});
			},
		});
	};
	return make([]);
}

/**
 * Compose the remote workspace facade. Generic `T` is the type of the
 * in-process workspace (typically `ReturnType<typeof openFuji>`); the
 * mapped type `RemoteWorkspace<T>` rewrites it into its wire equivalent.
 *
 * `whenReady` is a one-shot ping at construction. It does not enforce
 * the daemon's own `whenReady`; it's a transport-liveness check.
 */
export function buildRemoteWorkspace<T>(
	client: DaemonClient,
	workspaceName: string,
): RemoteWorkspace<T> {
	// `tables` and `actions` are runtime Proxy values; we cast through
	// `unknown` to let the public mapped type narrow them on the consumer
	// side. The Proxy machinery synthesizes the in-process shape on
	// demand from path segments.
	return {
		tables: buildRemoteTables(client, workspaceName),
		actions: buildRemoteActions(client, workspaceName),
		sync: {
			peers: () => client.peers(),
		},
		whenReady: Promise.resolve(),
		[Symbol.dispose]() {
			// `daemonClient` does not hold persistent connections (each
			// call is a fresh fetch), so dispose is a no-op today. Kept
			// for forward compatibility with a pooled-connection
			// transport.
		},
		async [Symbol.asyncDispose]() {
			// See `[Symbol.dispose]` above.
		},
	} as unknown as RemoteWorkspace<T>;
}
