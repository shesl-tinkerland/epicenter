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
 * ## Reads
 *
 * One classified read in two arities: `read(key)` for a point lookup (`absent`
 * / `present` / `unreadable`), `reads()` to walk every stored entry as a
 * `[key, KvStoredRead<T>]`. There is no separate "readable entries" or
 * "unreadable entries" iterator: a single pass over `reads()` partitions the
 * store, so `size` and the caller's buckets reconcile by construction instead
 * of by walking the entries twice and decrypting each one twice.
 *
 * ## Write shape
 *
 * `bulkSet()` takes `KvEntry<T> = { key, val }`. The underlying LWW store keeps
 * a wider shape (`{ key, val, ts }`), but `ts` is an implementation detail that
 * doesn't cross this boundary.
 */

/** Key/value pair accepted by `bulkSet()`. */
export type KvEntry<T> = { key: string; val: T };

/**
 * A stored entry resolved into one of the two states a key that *exists* can be
 * in: `present` (this store surfaced the value) or `unreadable` (the entry is
 * stored but this store cannot surface its value, an encrypted blob with no
 * usable key). `reason` is a human-readable diagnostic (for example
 * `keyVersion=3 not in keyring [1, 2]`), not a stable machine code.
 *
 * This is what `reads()` yields per entry. It deliberately excludes `absent`:
 * iterating stored entries can never produce a key that isn't there. {@link
 * KvRead} adds `absent` for the point read, where "no such key" is an answer.
 */
export type KvStoredRead<T> =
	| { state: 'present'; val: T }
	| { state: 'unreadable'; reason: string };

/**
 * The result of a single point read: a {@link KvStoredRead} plus `absent` for
 * the key that isn't stored. Exactly one of three mutually exclusive states, so
 * one `read()` answers every question a caller has about a key without a second
 * probe:
 *
 * - `absent`: no entry is stored under this key.
 * - `present`: an entry is stored and this store surfaced its value.
 * - `unreadable`: an entry is stored but this store cannot surface its value.
 *
 * `get()` and `has()` derive from this: `get()` is the value of the `present`
 * state, `has()` is "not `absent`" (raw existence, so it agrees with `size`).
 * The encrypted wrapper resolves the whole tri-state with one inner read and
 * one decrypt attempt, instead of decrypting once to get the value and again
 * to recover the failure reason.
 */
export type KvRead<T> = { state: 'absent' } | KvStoredRead<T>;

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
	/**
	 * Walk every stored entry once, each classified as `present` or `unreadable`
	 * (never `absent`: iterating storage cannot surface a missing key). The bulk
	 * twin of `read()`, and the only enumeration the store offers. A caller that
	 * wants just the readable values filters `state === 'present'`; one that
	 * wants the undecryptable ones filters `state === 'unreadable'`. Because both
	 * fall out of a single pass, the buckets and `size` reconcile by construction
	 * rather than by walking the store twice and decrypting each entry twice.
	 */
	reads(): IterableIterator<[string, KvStoredRead<T>]>;
	/**
	 * Number of stored entries after conflict resolution, **including**
	 * present-but-unreadable entries: exactly the count `reads()` yields.
	 * Encrypted stores count undecryptable blobs here so the count never
	 * disagrees with what storage holds.
	 */
	readonly size: number;
}
