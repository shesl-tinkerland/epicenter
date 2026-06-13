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

/**
 * The result of a single point read. Exactly one of three mutually exclusive
 * states, so one `read()` answers every question a caller has about a key
 * without a second probe:
 *
 * - `absent`: no entry is stored under this key.
 * - `present`: an entry is stored and this store surfaced its value.
 * - `unreadable`: an entry is stored but this store cannot surface its value
 *   (an encrypted blob with no usable key). `reason` is the same
 *   human-readable diagnostic `unreadableEntries()` yields for the key.
 *
 * `get()` and `has()` derive from this: `get()` is the value of the `present`
 * state, `has()` is "not `absent`" (raw existence, so it agrees with `size`).
 * The encrypted wrapper resolves the whole tri-state with one inner read and
 * one decrypt attempt, instead of decrypting once to get the value and again
 * to recover the failure reason.
 */
export type KvRead<T> =
	| { state: 'absent' }
	| { state: 'present'; val: T }
	| { state: 'unreadable'; reason: string };

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
	/**
	 * Resolve a key into one of three states in a single read: `absent`,
	 * `present` (with the value), or `unreadable` (with the reason). This is the
	 * primitive point read; `get()` and `has()` derive from it. The encrypted
	 * wrapper implements it with one inner read and one decrypt attempt, so a
	 * caller that needs to tell "absent" from "present but unreadable" pays a
	 * single decrypt instead of probing twice. See {@link KvRead}.
	 */
	read(key: string): KvRead<T>;
	/** The value stored under `key`, or `undefined` when it is absent or unreadable. The `present` value of {@link read}. */
	get(key: string): T | undefined;
	set(key: string, val: T): void;
	/**
	 * Whether an entry is stored under `key`, readable or not: `true` for both
	 * `present` and `unreadable` reads, `false` only for `absent`. Raw existence,
	 * so it agrees with `size` (which counts present-but-unreadable entries too).
	 */
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
	 * Number of stored entries after conflict resolution, **including**
	 * present-but-unreadable entries. The sum of the readable entries and
	 * `unreadableEntries()`. Encrypted stores count undecryptable blobs here so
	 * the count never disagrees with what storage holds.
	 */
	readonly size: number;
}
