/**
 * `buildRemoteProxy<T>(send)`: build a typed remote-action JS Proxy.
 *
 * Returns a Proxy whose dot-path is converted to the action arg passed to
 * `send`: `proxy.tabs.close({ tabIds })` calls
 * `send('tabs.close', { tabIds })`. Each leaf is
 * `(input?, options?) => Promise<Result<T, E | RpcError>>`.
 *
 * Used by `SyncAttachment.peer()` in `@epicenter/workspace` to materialize
 * the typed cross-device dispatch surface. Lives here because the
 * action-tree types it composes against (`Actions`, `RemoteActions`) live
 * in this package.
 */

import type { Result } from 'wellcrafted/result';
import type { Actions, RemoteActions, RemoteCallOptions } from './actions';
import type { RpcError } from './rpc-errors';

/**
 * The dispatch callback consumed by {@link buildRemoteProxy}. Receives the
 * dotted action path (e.g. `'tabs.close'`), the input payload, and any
 * per-call options. Must resolve with a `Result` envelope; the proxy
 * passes it through unchanged.
 */
export type Sender = (
	path: string,
	input: unknown,
	options?: RemoteCallOptions,
) => Promise<Result<unknown, RpcError>>;

export function buildRemoteProxy<TActions extends Actions>(
	send: Sender,
): RemoteActions<TActions> {
	function recurse(path: string[]): unknown {
		// Wrap `target` in a function so the Proxy is callable: the `apply`
		// trap fires for any leaf invocation. The function body is unused.
		const target = function () {} as unknown as object;
		return new Proxy(target, {
			get(_t, prop) {
				if (typeof prop !== 'string') return undefined;
				return recurse([...path, prop]);
			},
			apply(_t, _this, args: unknown[]) {
				const [input, options] = args as [unknown?, RemoteCallOptions?];
				return send(path.join('.'), input, options);
			},
		});
	}
	return recurse([]) as RemoteActions<TActions>;
}
