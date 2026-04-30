/**
 * `peer<T>(transport, deviceId)`: typed remote-action proxy for one peer.
 *
 * The single public API for cross-device action dispatch. Returns a JavaScript
 * Proxy whose method calls dispatch over the transport's existing
 * `rpc(...)` channel. Each leaf is `(input?, options?) => Promise<Result<T, E | RpcError>>`.
 *
 * The proxy is stateless: every call resolves the deviceId against the
 * transport's `find` (first-match in clientId-ascending order) and dispatches
 * via `transport.rpc`. If the matched peer disappears mid-call, the in-flight
 * Promise rejects immediately with `RpcError.PeerLeft` rather than waiting
 * for the timeout.
 *
 * Per-installation deviceId convention (see `getOrCreateDeviceId` in
 * `@epicenter/workspace`) makes first-match-wins safe: same deviceId means
 * same logical device means interchangeable runtimes.
 *
 * @example
 * ```ts
 * import { peer } from '@epicenter/sync';
 * import type { TabManagerActions } from '@epicenter/tab-manager';
 *
 * const macbook = peer<TabManagerActions>(fuji.sync, 'macbook-pro');
 * const result = await macbook.tabs.close({ tabIds: [1, 2] }, { timeout: 5_000 });
 * if (result.error) toast.error(extractErrorMessage(result.error));
 * else toast.success(`closed ${result.data.closedCount} tabs`);
 * ```
 */

import { Err, Ok, isResult, type Result } from 'wellcrafted/result';
import type {
	ActionManifest,
	Actions,
	RemoteActions,
	RemoteCallOptions,
	SystemActions,
} from './actions';
import { RpcError } from './rpc-errors';

/**
 * Minimal transport surface required by `peer<T>`. Workspace's
 * `SyncAttachment` satisfies this structurally: pass `workspace.sync`
 * directly. The interface stays here (rather than importing the full
 * `SyncAttachment`) so `@epicenter/sync` doesn't depend on
 * `@epicenter/workspace`.
 */
export type PeerTransport = {
	/**
	 * Resolve a deviceId to its current Yjs awareness clientId. Returns
	 * `undefined` when no peer publishing the deviceId is connected.
	 */
	find(deviceId: string): { clientId: number } | undefined;
	/**
	 * Subscribe to peer change events. Fires when peers join, leave, or
	 * update state. Returns an unsubscribe function.
	 */
	observe(callback: () => void): () => void;
	/**
	 * Dispatch a typed RPC call to a peer's awareness clientId. The proxy
	 * passes the dotted action path, the input payload, and the optional
	 * per-call options through to this method. Workspace's `SyncAttachment.rpc`
	 * returns `Promise<Result<TOut, RpcError>>` and structurally satisfies
	 * this looser shape; `peer<T>` re-narrows the data type at each leaf via
	 * `RemoteActions<TActions>`.
	 */
	rpc(
		target: number,
		action: string,
		input?: unknown,
		options?: RemoteCallOptions,
	): Promise<Result<unknown, RpcError>>;
};

/**
 * Build a typed peer proxy for `deviceId`. Each leaf method dispatches via
 * `transport.rpc` and returns `Promise<Result<T, E | RpcError>>`.
 *
 * Takes a `PeerTransport` (typically a workspace's `sync` field): sync owns
 * peer discovery (`find`, `observe`) since it's the source of truth for
 * who's connected. Pass the workspace bundle's `sync` field, e.g.
 * `peer<TActions>(fuji.sync, 'mac')`.
 */
export function peer<TActions extends Actions>(
	transport: PeerTransport,
	deviceId: string,
): RemoteActions<TActions> {
	const send: Sender = async (path, input, options) => {
		const found = transport.find(deviceId);
		if (!found) return Err(RpcError.PeerNotFound({ peer: deviceId }).error);

		// Race the rpc against a peer-removed signal. If the matched peer
		// disappears mid-call, reject immediately: don't wait for the timeout.
		return new Promise<Result<unknown, RpcError>>((resolveCall) => {
			let settled = false;
			const settle = (v: Result<unknown, RpcError>) => {
				if (settled) return;
				settled = true;
				unsubscribe();
				resolveCall(v);
			};
			const unsubscribe = transport.observe(() => {
				if (!transport.find(deviceId)) {
					settle(Err(RpcError.PeerLeft({ peer: deviceId }).error));
				}
			});

			transport
				.rpc(found.clientId, path, input, options)
				.then((res) => settle(isResult(res) ? res : Ok(res as unknown)))
				.catch((cause) =>
					settle(Err(RpcError.ActionFailed({ action: path, cause }).error)),
				);
		});
	};

	return buildProxy<RemoteActions<TActions>>([], send);
}

type Sender = (
	path: string,
	input: unknown,
	options?: RemoteCallOptions,
) => Promise<Result<unknown, RpcError>>;

type SystemMeta = { system: SystemActions };

/**
 * Fetch a peer's full action manifest via the runtime-injected `system.describe`
 * RPC. Returns the same `ActionManifest` shape the local `describeActions` walker
 * produces, with live `input` schemas retained.
 *
 * Thin wrapper around {@link peer}: inherits its peer-resolution and
 * peer-removed race semantics.
 *
 * @example
 * ```ts
 * const result = await describePeer(workspace.sync, 'macbook-pro');
 * if (result.error) toast.error(extractErrorMessage(result.error));
 * else for (const [path, meta] of Object.entries(result.data)) { ... }
 * ```
 */
export function describePeer(
	transport: PeerTransport,
	deviceId: string,
): Promise<Result<ActionManifest, RpcError>> {
	return peer<SystemMeta>(transport, deviceId).system.describe();
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
