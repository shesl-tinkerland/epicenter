/**
 * # ObservableKvStore
 *
 * The shared contract between `YKeyValueLww` and the encrypted wrapper.
 * both live in `@epicenter/workspace`. Consumers like
 * `createTable` / `createKv` depend on this interface, not on any specific
 * store implementation, so the same helper logic runs over plaintext and
 * encrypted stores alike.
 *
 * ## Why not `LwwStore<T>`?
 *
 * The old name leaked an implementation detail. Nothing in this interface
 * mentions timestamps or conflict-resolution policy; it's just a keyed store
 * that emits change events. "LWW" is how `YKeyValueLww` decides the winner
 * internally, but callers of this interface don't care.
 *
 * ## Entry shape
 *
 * `entries()` yields `[key, KvEntry<T>]` where `KvEntry<T> = { key, val }`.
 * The underlying LWW store stores a wider entry shape (`{ key, val, ts }`),
 * but `ts` is an implementation detail that doesn't cross this boundary.
 */

/** Public entry shape surfaced by `entries()`. */
export type KvEntry<T> = { key: string; val: T };

/**
 * An entry that exists in storage but whose value this store cannot surface:
 * an encrypted blob with no usable key in the keyring. `entries()` skips it and
 * `get()` reports it absent, but `size` counts it and `unreadableEntries()`
 * yields it, so it is never invisible to every read.
 *
 * `reason` is a human-readable diagnostic (for example
 * `keyVersion=3 not in keyring [1, 2]`), not a stable machine code.
 */
export type KvUnreadableEntry = { key: string; reason: string };

/** Change event emitted by the store's observer. */
export type KvStoreChange<T> =
	| { action: 'add'; newValue: T }
	| { action: 'update'; newValue: T }
	| { action: 'delete' };

/** Signature of an observer registered via `observe()`. */
export type KvStoreChangeHandler<T> = (
	changes: Map<string, KvStoreChange<T>>,
	origin: unknown,
) => void;

/**
 * Observable, bulk-capable keyed store.
 *
 * Implemented by `YKeyValueLww` (unencrypted) and the encrypted wrapper in
 * `@epicenter/workspace`. `createTable` / `createKv` consume this interface
 * so they can wrap either backend without branching.
 */
export interface ObservableKvStore<T> {
	get(key: string): T | undefined;
	set(key: string, val: T): void;
	has(key: string): boolean;
	delete(key: string): void;
	bulkSet(entries: Array<KvEntry<T>>): void;
	bulkDelete(keys: string[]): void;
	observe(handler: KvStoreChangeHandler<T>): void;
	unobserve(handler: KvStoreChangeHandler<T>): void;
	entries(): IterableIterator<[string, KvEntry<T>]>;
	/**
	 * Entries that exist in storage but did not yield a value (encrypted blobs
	 * with no usable key). Plaintext stores always yield nothing. The encrypted
	 * wrapper yields the set its `get()` reports absent and its `entries()`
	 * skips. Together with `entries()` this partitions the stored entries that
	 * `size` counts, which is what lets a stored count reconcile against reads.
	 */
	unreadableEntries(): IterableIterator<KvUnreadableEntry>;
	/**
	 * If `key` is present in storage but did not yield a value (an encrypted
	 * blob with no usable key), the human-readable reason; otherwise `undefined`
	 * (the key is absent, or readable). O(1) point probe: the per-key form of
	 * `unreadableEntries()`. Plaintext stores always return `undefined`. A write
	 * guard uses this to tell "absent" (safe to overwrite) from "present but
	 * unreadable" (refuse, lest it clobber a row it cannot read).
	 */
	unreadableReason(key: string): string | undefined;
	/**
	 * Number of stored entries after conflict resolution, **including**
	 * present-but-unreadable entries. The sum of the readable entries and
	 * `unreadableEntries()`. Encrypted stores count undecryptable blobs here so
	 * the count never disagrees with what storage holds.
	 */
	readonly size: number;
}
