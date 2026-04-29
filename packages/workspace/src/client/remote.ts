/**
 * `buildRemoteProxy` — typed proxy that turns a `DaemonClient` into a
 * workspace-shaped facade. Local call sites use the same dotted path they
 * would in-process (`tables.X.set(...)`, `savedTabs.create(...)`); each
 * call dispatches over the unix socket via `client.run`.
 *
 * The proxy is a single recursive `Proxy` rooted at the workspace itself.
 * Property access walks the chain and accumulates path segments; calling
 * the resulting proxy invokes `client.run` with the joined dotted path.
 * That same machinery powered the old `actions` proxy: it is prefix-
 * agnostic, so dropping the `actions` namespace is a no-op for runtime.
 *
 * `then` is masked at every level so an accidental `await ws.tables.x` does
 * not turn an intermediate namespace into a thenable and pollute the path
 * with a stray `.then` segment.
 *
 * The branded CRUD methods on `attachTable` mount on the in-process
 * workspace at the same paths (`tables.<name>.<verb>`), so the same routes
 * serve both directions.
 */

import type { DaemonClient } from '../daemon/client.js';
import type { Remote } from './remote-workspace-types.js';

/** Default `waitMs` value we send on every `/run` request. */
const DEFAULT_WAIT_MS = 5000;

/**
 * Recursive proxy rooted at the workspace. Property access produces another
 * proxy carrying the path-so-far; calling the proxy dispatches `client.run`
 * with the joined dotted path.
 *
 * `function () {}` is the proxy target so `apply` is reachable. The `then`
 * key is masked everywhere on the path (otherwise an `await` on an
 * intermediate namespace would turn it into a thenable).
 */
function buildRemoteProxy(client: DaemonClient, workspaceName: string): unknown {
	const make = (path: string[]): unknown => {
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
 * Compose the remote workspace facade. Generic `W` is the in-process
 * workspace shape; `Remote<W>` filters it to branded leaves only and
 * rewrites each leaf to `Promise<Result<_, _ | RpcError>>`.
 */
export function buildRemoteWorkspace<W>(
	client: DaemonClient,
	workspaceName: string,
): Remote<W> {
	return buildRemoteProxy(client, workspaceName) as Remote<W>;
}
