/**
 * `buildRemoteProxy<T>(send)`: low-level proxy-builder shared by every
 * remote-action dispatch site.
 *
 * Returns a JavaScript Proxy whose dot-path is converted to the action arg
 * passed to `send`: `proxy.tabs.close({ tabIds })` calls
 * `send('tabs.close', { tabIds })`. Each leaf is
 * `(input?, options?) => Promise<Result<T, E | RpcError>>`.
 *
 * The proxy itself has no notion of peers, awareness, or transports: it is
 * pure dot-path → string conversion + Result normalization. Callers
 * (typically `SyncAttachment.peer()` in `@epicenter/workspace`) build a
 * `Sender` that resolves a deviceId, races against peer-removal, and
 * dispatches via their own `rpc` channel.
 *
 * @example
 * ```ts
 * const send: Sender = async (path, input, options) => {
 *   return mySync.rpc(targetClientId, path, input, options);
 * };
 * const remote = buildRemoteProxy<TabManagerActions>(send);
 * const result = await remote.tabs.close({ tabIds: [1, 2] });
 * ```
 */

import { Ok, isResult, type Result } from 'wellcrafted/result';
import type { Actions, RemoteActions, RemoteCallOptions } from './actions';
import { RpcError } from './rpc-errors';

/**
 * The dispatch callback consumed by {@link buildRemoteProxy}. Receives the
 * dotted action path (e.g. `'tabs.close'`), the input payload, and any
 * per-call options. Implementations return either a `Result` (which is
 * passed through) or a raw value (auto-wrapped as `Ok`).
 */
export type Sender = (
	path: string,
	input: unknown,
	options?: RemoteCallOptions,
) => Promise<Result<unknown, RpcError>>;

/**
 * Build a typed remote-action proxy from a `send` callback. See module
 * JSDoc for the dispatch contract.
 */
export function buildRemoteProxy<TActions extends Actions>(
	send: Sender,
): RemoteActions<TActions> {
	const wrapped: Sender = async (path, input, options) => {
		try {
			const res = await send(path, input, options);
			return isResult(res) ? res : Ok(res as unknown);
		} catch (cause) {
			return RpcError.ActionFailed({ action: path, cause });
		}
	};
	return buildProxy<RemoteActions<TActions>>([], wrapped);
}

/**
 * Recursive Proxy: walking `proxy.tabs.close` returns nested proxies; calling
 * `proxy.tabs.close({...})` invokes `send('tabs.close', {...})`. The runtime
 * value is wrapped in a no-op function so `apply` works on any property path.
 */
function buildProxy<T>(path: string[], send: Sender): T {
	const target = function () {
		// no-op runtime body; only `apply` is used
	} as unknown as object;
	return new Proxy(target, {
		get(_t, prop) {
			if (typeof prop !== 'string') return undefined;
			return buildProxy([...path, prop], send);
		},
		apply(_t, _this, args: unknown[]) {
			const [input, options] = args as [unknown?, RemoteCallOptions?];
			return send(path.join('.'), input, options);
		},
	}) as T;
}
