import { BC_ORIGIN, isTransportOrigin } from '@epicenter/sync';
import * as Y from 'yjs';

/**
 * Local-only BroadcastChannel cross-tab sync for a Yjs document.
 *
 * Broadcasts every local `updateV2` to same-origin tabs and applies incoming
 * updates from other tabs. Defaults the channel key to `ydoc.guid` so only
 * docs for the same local workspace communicate. Authenticated browser
 * workspaces should pass an owner-scoped key (via `LocalOwner`) so two
 * signed-in subjects in the same browser profile cannot exchange plaintext.
 *
 * Skips re-broadcasting updates that arrived from BroadcastChannel itself
 * (via `BC_ORIGIN`) and updates that arrived from WebSocket sync. Without
 * those guards, delivered updates would be re-broadcast to other tabs, and
 * those tabs would re-send them.
 *
 * No-ops gracefully when `BroadcastChannel` is unavailable (Node.js, SSR,
 * older browsers).
 */
export function attachBroadcastChannel(
	ydoc: Y.Doc,
	channelKey: string = ydoc.guid,
): void {
	if (typeof BroadcastChannel === 'undefined') {
		return;
	}

	const channel = new BroadcastChannel(`yjs.${channelKey}`);

	const handleUpdate = (update: Uint8Array, origin: unknown) => {
		if (isTransportOrigin(origin)) return;
		channel.postMessage(update);
	};
	ydoc.on('updateV2', handleUpdate);

	channel.onmessage = (event: MessageEvent) => {
		Y.applyUpdateV2(ydoc, new Uint8Array(event.data), BC_ORIGIN);
	};

	ydoc.once('destroy', () => {
		ydoc.off('updateV2', handleUpdate);
		channel.close();
	});
}
