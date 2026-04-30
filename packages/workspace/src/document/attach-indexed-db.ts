import { IndexeddbPersistence } from 'y-indexeddb';
import type * as Y from 'yjs';

export type IndexedDbAttachment = {
	/**
	 * Resolves when local IndexedDB state has loaded into the Y.Doc: "your
	 * draft is in memory, edits are safe." Not CRDT convergence despite
	 * `y-indexeddb`'s upstream `whenSynced` name. Pair with `sync.whenConnected`
	 * when you also need remote state.
	 */
	whenLoaded: Promise<unknown>;
	clearLocal: () => Promise<void>;
	/**
	 * Resolves after the Y.Doc is destroyed AND IndexedDB's async teardown
	 * completes. Opt-in: tests and CLIs flushing before exit await this.
	 * Named symmetrically with `whenLoaded`: both are promises.
	 */
	whenDisposed: Promise<unknown>;
};

export function attachIndexedDb(ydoc: Y.Doc): IndexedDbAttachment {
	const idb = new IndexeddbPersistence(ydoc.guid, ydoc);
	const { promise: whenDisposed, resolve: resolveDisposed } =
		Promise.withResolvers<void>();
	// `IndexeddbPersistence` already registers its own `doc.on('destroy')` to
	// tear itself down. We still register here to surface an *awaitable* signal
	// for the async IDB close: calling `idb.destroy()` a second time is safe
	// (idempotent after `_destroyed = true`) and returns the same close promise.
	ydoc.once('destroy', async () => {
		try {
			await idb.destroy();
		} finally {
			resolveDisposed();
		}
	});
	return {
		whenLoaded: idb.whenSynced,
		clearLocal: () => idb.clearData(),
		whenDisposed,
	};
}
