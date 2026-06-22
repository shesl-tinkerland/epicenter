/**
 * attachKvStore(): bind a per-key last-write-wins JSON store on a Y.Doc to a
 * typed handle.
 *
 * Reserves `ydoc.getArray(key)` (default `'entries'`) and wraps it in a
 * {@link YKeyValueLww}: each key maps to one complete JSON value, concurrent
 * writes to the same key resolve last-write-wins by timestamp, and storage
 * scales with live data rather than history (gc compacts overwrites and
 * deletes). The Y types stay inside the handle; callers see plain objects in,
 * plain objects out.
 *
 * Use it as a child-doc layout when a row's document is a keyed bag of complete
 * records rather than a streamed body. Each value is written once, whole, the
 * way a server would persist a finished record:
 *
 * ```ts
 * defineTable({ id: field.string() })
 *   .docs({ items: (ydoc) => attachKvStore<Item>(ydoc) });
 * // then tables.X.docs.items.open(rowId) returns this handle, keyed by item id.
 * ```
 *
 * Handle-style attachment: synchronous, no async teardown. Destroying the Y.Doc
 * disposes the underlying store and releases the array.
 */
import type * as Y from 'yjs';
import type { KvEntry } from './y-keyvalue/observable-kv-store.js';
import {
	YKeyValueLww,
	type YKeyValueLwwEntry,
} from './y-keyvalue/y-keyvalue-lww.js';

/** The typed surface {@link attachKvStore} returns over a child doc. */
export type KvStoreHandle<T> = {
	/** The value stored under `key`, or `undefined` when it is absent. */
	get(key: string): T | undefined;
	/** Write the complete value under `key`, overwriting any previous one. */
	set(key: string, value: T): void;
	/** Remove the value under `key`. */
	delete(key: string): void;
	/** Walk every stored value as a `{ key, val }` pair. */
	entries(): IterableIterator<KvEntry<T>>;
	/**
	 * Register a change handler and get back the function that removes it. The
	 * handler fires once per transaction, for local writes and synced remote ones
	 * alike, and carries no payload: a consumer re-reads {@link entries} to
	 * refresh. The underlying store computes a change set, but the only consumer of
	 * this handle (the agent loop) re-reads wholesale, so the seam is a bare change
	 * signal.
	 */
	observe(handler: () => void): () => void;
};

/**
 * Attach a key-value store to `ydoc` at `key` (default `'entries'`).
 *
 * @param ydoc - Y.Doc to attach to
 * @param key  - name of the `Y.Array` slot that backs the store
 */
export function attachKvStore<T>(
	ydoc: Y.Doc,
	key = 'entries',
): KvStoreHandle<T> {
	const store = new YKeyValueLww<T>(ydoc.getArray<YKeyValueLwwEntry<T>>(key));
	ydoc.once('destroy', () => store[Symbol.dispose]());
	return {
		get: (k) => store.get(k),
		set: (k, value) => store.set(k, value),
		delete: (k) => store.delete(k),
		entries: () => store.entries(),
		observe: (handler) => store.observe(handler),
	};
}
