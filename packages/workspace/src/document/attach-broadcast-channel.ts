import * as Y from 'yjs';
import { BC_ORIGIN } from '@epicenter/sync';

export { BC_ORIGIN };

export type BroadcastChannelAttachment = {
	/**
	 * Resolves after the Y.Doc is destroyed AND the BroadcastChannel is closed.
	 * Named symmetrically with `attachIndexedDb`'s `whenDisposed`: opt-in signal
	 * for tests and CLIs flushing before exit.
	 */
	whenDisposed: Promise<unknown>;
};

/**
 * BroadcastChannel cross-tab sync for a Yjs document.
 *
 * Broadcasts every local `updateV2` to same-origin tabs and applies incoming
 * updates from other tabs. Uses `ydoc.guid` as the channel name so only docs
 * for the same workspace communicate.
 *
 * Skips re-broadcasting updates that arrived from BroadcastChannel itself
 * (via `BC_ORIGIN`) and, when paired with another transport, updates that
 * arrived from that transport (via `transportOrigin`). Without the second
 * guard, transport-delivered updates would be re-broadcast to other tabs,
 * and those tabs would re-send them: creating an echo loop.
 *
 * No-ops gracefully when `BroadcastChannel` is unavailable (Node.js, SSR,
 * older browsers).
 *
 * @param ydoc - The Y.Doc to sync across tabs
 * @param opts.transportOrigin - Optional origin Symbol from another transport
 *   (e.g., `SYNC_ORIGIN` from `attachSync`). Updates with this origin are not
 *   re-broadcast, preventing cross-transport echo loops.
 */
export function attachBroadcastChannel(
	ydoc: Y.Doc,
	opts: { transportOrigin?: symbol } = {},
): BroadcastChannelAttachment {
	if (typeof BroadcastChannel === 'undefined') {
		return { whenDisposed: Promise.resolve() };
	}

	const { transportOrigin } = opts;
	const channel = new BroadcastChannel(`yjs:${ydoc.guid}`);
	const { promise: whenDisposed, resolve: resolveDisposed } =
		Promise.withResolvers<void>();

	/** Broadcast local changes to other tabs.
	 *  Skips updates from BroadcastChannel itself (echo prevention) and from
	 *  the paired transport (e.g., WebSocket) to avoid cross-transport echo. */
	const handleUpdate = (update: Uint8Array, origin: unknown) => {
		if (origin === BC_ORIGIN) return;
		if (transportOrigin && origin === transportOrigin) return;
		channel.postMessage(update);
	};
	ydoc.on('updateV2', handleUpdate);

	/** Apply incoming changes from other tabs. */
	channel.onmessage = (event: MessageEvent) => {
		Y.applyUpdateV2(ydoc, new Uint8Array(event.data), BC_ORIGIN);
	};

	ydoc.once('destroy', () => {
		try {
			ydoc.off('updateV2', handleUpdate);
			channel.close();
		} finally {
			resolveDisposed();
		}
	});

	return { whenDisposed };
}
