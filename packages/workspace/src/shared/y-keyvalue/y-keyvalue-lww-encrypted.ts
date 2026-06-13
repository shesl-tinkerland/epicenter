/**
 * # Encrypted KV-LWW: Composition Wrapper
 *
 * Transparent encryption layer over `YKeyValueLww`. All CRDT logic (timestamps,
 * conflict resolution, pending/map architecture) stays in `YKeyValueLww`; this
 * module transforms values at the boundary.
 *
 * ## Why Composition Over Fork
 *
 * Yjs `ContentAny` stores entry objects by **reference**. `YKeyValueLww` relies
 * on `indexOf()` (strict `===`) to find entries in the Y.Array during conflict
 * resolution. A fork that decrypts into new objects breaks `indexOf`: the map
 * entries are no longer the same JS objects as the yarray entries.
 *
 * See `docs/articles/yjs-reference-equality-why-we-compose-encrypted-crdts.md`.
 *
 * ## Data Flow
 *
 * ```
 * set('tab-1', { url: '...' })
 *   ├── JSON.stringify → encryptValue → Uint8Array [fmt‖keyVer‖nonce‖ct‖tag]
 *   └── inner.set('tab-1', encryptedBlob)              ← CRDT source of truth
 *
 * get('tab-1')
 *   └── inner.get('tab-1') → decrypt on the fly        ← ~0.01ms per value
 * ```
 *
 * There is no plaintext cache. Every read decrypts from the inner store.
 * XChaCha20-Poly1305 decrypt of a small JSON blob is microseconds. Caching
 * adds complexity (dual-map sync, diffAndEmit, transaction-gap fallback)
 * for negligible performance gain.
 *
 * ## Encryption Lifecycle
 *
 * Encryption is **one-way** by API surface. There is no
 * `deactivateEncryption()`. Once `activateEncryption()` is called, the
 * `encryption` state is set and no method clears it. The only reset
 * path is destroying the wrapper as part of an app-owned local reset.
 *
 * ## Re-encryption on Activation
 *
 * When `activateEncryption()` is called, every entry converges to the current
 * key version: plaintext is encrypted, old-version ciphertext (decryptable via
 * the keyring) is re-encrypted under the current key, current-version
 * ciphertext is skipped, and ciphertext at an unknown version is left alone
 * (it'll catch up on a future `activateEncryption()` that includes the key).
 * This makes `activateEncryption()` the one method that handles both
 * post-login encryption and key rotation.
 *
 * ## Error Containment
 *
 * The observer wraps decrypt with try/catch. A failed decrypt skips the entry
 * and logs a warning instead of throwing. This prevents one bad blob from
 * crashing all observation. `reads()` yields the skipped entries as
 * `unreadable` (key plus reason) so they stay visible to reads and the count.
 *
 * ## Related Modules
 *
 * - `@epicenter/encryption`: Encryption primitives (encryptValue, decryptValue, isEncryptedBlob)
 * - {@link ./y-keyvalue-lww.ts}: Inner CRDT that handles conflict resolution (unaware of encryption)
 * - `attachEncryptedIndexedDb` (document/): the local update-log layer. It
 *   deliberately has no `activateEncryption` counterpart: it snapshots the
 *   keyring once at attach, and its compaction rewrites old-version rows as
 *   a side effect. The explicit surface lives here and not there because
 *   this wrapper's at-rest data is the durable, synced CRDT, while the
 *   update log is a per-device cache.
 *
 * @module
 */

import {
	decryptValue,
	type EncryptedBlob,
	encryptValue,
	getKeyVersion,
	isEncryptedBlob,
	type ReadonlyWorkspaceKeyring,
} from '@epicenter/encryption';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { createLogger, type Logger } from 'wellcrafted/logger';
import type * as Y from 'yjs';
import {
	type KvEntry,
	type KvRead,
	type KvStoreChange,
	type KvStoreChangeHandler,
	type KvStoredRead,
	YKeyValueLww,
	type YKeyValueLwwEntry,
} from '../../document/y-keyvalue/index.js';

/**
 * Errors emitted when the encrypted observer fails to decrypt an entry.
 * Silent-data-loss territory. We log and continue, but the log is the only
 * record this happened, so it's typed so apps can aggregate/count.
 */
export const EncryptedKvError = defineErrors({
	DecryptFailed: ({ key, reason }: { key: string; reason: string }) => ({
		message: `[encrypted-kv] Failed to decrypt entry "${key}": ${reason}`,
		key,
		reason,
	}),
});
export type EncryptedKvError = InferErrors<typeof EncryptedKvError>;

const textEncoder = new TextEncoder();
/** Transaction origin for re-encryption writes. Observer skips events with this origin. */
const REENCRYPT_ORIGIN = Symbol('re-encrypt');

type EncryptionState = {
	keyring: ReadonlyWorkspaceKeyring;
	currentKey: Uint8Array;
	currentVersion: number;
};

/**
 * Return type of `createEncryptedYkvLww`.
 *
 * IS-A `ObservableKvStore<T>` (the shared contract, including the classified
 * `read()` / `reads()`) plus encryption lifecycle (`activateEncryption`),
 * disposal, and direct access to the underlying `yarray` / `doc` for sync
 * providers.
 *
 * All values exposed through the `ObservableKvStore` surface are **plaintext**.
 * Encryption is transparent to consumers.
 */
export type EncryptedYKeyValueLww<T> = ReturnType<
	typeof createEncryptedYkvLww<T>
>;

/**
 * Compose transparent encryption onto `YKeyValueLww` without forking CRDT logic.
 *
 * `YKeyValueLww` remains the single source for conflict resolution; this wrapper
 * only transforms values at the boundary (`set` encrypts, `get`/observer decrypts).
 *
 * Construction always starts in passthrough mode: zero overhead, identical to
 * a plain `YKeyValueLww<T>`. Call `activateEncryption(keyring)` when the key
 * becomes available (typically post-login) to enable encryption and upgrade
 * any existing plaintext or old-version entries.
 *
 * @example
 * ```typescript
 * const kv = createEncryptedYkvLww<TabData>(ydoc, 'tabs');
 * kv.set('tab-1', { url: '...' }); // stored as plaintext
 *
 * kv.activateEncryption(new Map([[1, encryptionKey]]));
 * kv.set('tab-2', { url: '...' }); // stored as EncryptedBlob
 * // tab-1 was re-encrypted during activation
 * ```
 *
 * @param ydoc - The Y.Doc that owns the underlying Y.Array
 * @param arrayKey - Name of the Y.Array under `ydoc.getArray(arrayKey)`
 */
export function createEncryptedYkvLww<T>(
	ydoc: Y.Doc,
	arrayKey: string,
	{ log = createLogger('encrypted-kv') }: { log?: Logger } = {},
) {
	const yarray = ydoc.getArray<YKeyValueLwwEntry<EncryptedBlob | T>>(arrayKey);
	/**
	 * The inner LWW store. It sees `EncryptedBlob | T` as its value type. It
	 * doesn't know or care that some values are ciphertext. Timestamps, conflict
	 * resolution, and observer mechanics all live here.
	 */
	const inner = new YKeyValueLww<EncryptedBlob | T>(yarray);
	const changeHandlers = new Set<KvStoreChangeHandler<T>>();

	/** Active encryption state. `undefined` = passthrough mode. */
	let encryption: EncryptionState | undefined;

	/**
	 * Decrypt a stored value to plaintext, or return plaintext unchanged.
	 *
	 * - Plaintext input (non-blob) passes through regardless of state.
	 * - Blob + no state (passthrough mode) → undefined (unreadable).
	 * - Blob + state → try currentKey, fall back to the blob's recorded version.
	 *
	 * Silent on failure. Callers decide what to do with `undefined`.
	 *
	 * @param state Defaults to the closure's `encryption`. Overridden by
	 *   `activateEncryption()` to decrypt against `nextEncryption` without
	 *   confusing the closure mid-iteration.
	 */
	const decrypt = (
		stored: EncryptedBlob | T,
		aad: Uint8Array,
		state: EncryptionState | undefined = encryption,
	): T | undefined => {
		if (!isEncryptedBlob(stored)) return stored as T;
		if (!state) return undefined;
		try {
			return JSON.parse(decryptValue(stored, state.currentKey, aad)) as T;
		} catch {
			// Current key didn't work. Try the blob's recorded key version.
		}
		const versionKey = state.keyring.get(getKeyVersion(stored));
		if (!versionKey || versionKey === state.currentKey) return undefined;
		try {
			return JSON.parse(decryptValue(stored, versionKey, aad)) as T;
		} catch {
			return undefined;
		}
	};

	/**
	 * Produce the value to hand to the inner store: encrypted blob when a key
	 * is active, plaintext passthrough otherwise. Pure function of the
	 * closure's `encryption`.
	 */
	const toStored = (key: string, val: T): EncryptedBlob | T => {
		if (!encryption) return val;
		return encryptValue(
			JSON.stringify(val),
			encryption.currentKey,
			textEncoder.encode(key),
			encryption.currentVersion,
		);
	};

	/**
	 * Human-readable reason a blob did not decrypt under an active keyring:
	 * either its key version is missing from the keyring, or the key is present
	 * but the bytes are wrong (corruption or a tampered blob). The one place this
	 * string is formatted, shared by the observer warning and `classify()` so
	 * both describe the same failure identically.
	 */
	const decryptFailureReason = (
		keyring: ReadonlyWorkspaceKeyring,
		blob: EncryptedBlob,
	): string => {
		const blobVersion = getKeyVersion(blob);
		return keyring.has(blobVersion)
			? 'wrong key material or corrupted blob'
			: `keyVersion=${blobVersion} not in keyring [${[...keyring.keys()].join(', ')}]`;
	};

	/**
	 * Classify an already-fetched stored value into `present` or `unreadable`.
	 * The single owner of readability: `read()` calls it after one `inner.get`,
	 * `reads()` calls it once per inner entry, so point and bulk reads agree and
	 * each entry is decrypted exactly once.
	 *
	 * - Plaintext passthrough value (not a blob) → `present`.
	 * - Blob that decrypts under the active keyring → `present`.
	 * - Blob that does not decrypt → `unreadable` with the reason.
	 * - Blob in passthrough mode (no key active) → `unreadable`: the ciphertext
	 *   is stored but unreadable here, so it stays counted rather than vanishing
	 *   from reads while `size` still counts it.
	 *
	 * Never returns `absent`: the caller already holds a stored value. `read()`
	 * adds `absent` for the missing-key case before delegating here.
	 */
	const classify = (
		key: string,
		stored: EncryptedBlob | T,
	): KvStoredRead<T> => {
		if (!isEncryptedBlob(stored)) return { state: 'present', val: stored as T };
		if (encryption) {
			const val = decrypt(stored, textEncoder.encode(key));
			if (val !== undefined) return { state: 'present', val };
			return {
				state: 'unreadable',
				reason: decryptFailureReason(encryption.keyring, stored),
			};
		}
		return {
			state: 'unreadable',
			reason: `keyVersion=${getKeyVersion(stored)}, encryption not active`,
		};
	};

	/**
	 * Resolve a key into `absent`, `present`, or `unreadable` with one inner read
	 * and one decrypt attempt. The primitive point read the tri-state contract
	 * promises: a stored blob that did not decrypt comes back `unreadable` (with
	 * its reason) rather than masquerading as `absent`, so a caller never reads
	 * the value and then probes again for the reason.
	 *
	 * Reads `inner.get` (which sees pending writes) so a guard inside an open
	 * transaction classifies the same view it writes.
	 */
	const read = (key: string): KvRead<T> => {
		const stored = inner.get(key);
		if (stored === undefined) return { state: 'absent' };
		return classify(key, stored);
	};

	/**
	 * Inner observer. When entries change in the CRDT, decrypt and forward
	 * plaintext change events to registered handlers. Skips REENCRYPT_ORIGIN
	 * writes (those are internal re-encryption during activation, not user
	 * changes). Logs a single warning on undecryptable remote entries.
	 */
	const observer: KvStoreChangeHandler<EncryptedBlob | T> = (
		changes,
		origin,
	) => {
		if (origin === REENCRYPT_ORIGIN) return;
		const decryptedChanges = new Map<string, KvStoreChange<T>>();
		for (const [key, change] of changes) {
			if (change.action === 'delete') {
				decryptedChanges.set(key, { action: 'delete' });
				continue;
			}
			const entry = inner.map.get(key);
			if (!entry) continue;
			const val = decrypt(entry.val, textEncoder.encode(key));
			if (val === undefined) {
				if (encryption && isEncryptedBlob(entry.val)) {
					const reason = decryptFailureReason(encryption.keyring, entry.val);
					log.warn(EncryptedKvError.DecryptFailed({ key, reason }));
				}
				continue;
			}
			decryptedChanges.set(key, { action: change.action, newValue: val });
		}
		if (decryptedChanges.size === 0) return;
		for (const handler of changeHandlers) handler(decryptedChanges, origin);
	};

	/** Removes the inner observer; called by this wrapper's dispose. */
	const unobserveInner = inner.observe(observer);

	return {
		set(key: string, val: T): void {
			inner.set(key, toStored(key, val));
		},
		bulkSet(entries: Array<KvEntry<T>>): void {
			inner.bulkSet(
				entries.map(({ key, val }) => ({ key, val: toStored(key, val) })),
			);
		},
		/**
		 * Classify a key in one inner read and one decrypt attempt. The primitive
		 * point read; `get()` and `has()` derive from it. See {@link read}.
		 */
		read,
		/**
		 * Get a decrypted value by key. The `present` value of {@link read}, else
		 * `undefined`. Decrypts on the fly (~0.01ms for XChaCha20-Poly1305 on a
		 * small JSON blob); there is no plaintext cache.
		 */
		get(key: string): T | undefined {
			const result = read(key);
			return result.state === 'present' ? result.val : undefined;
		},
		/**
		 * Whether an entry is stored under `key`, readable or not. Raw existence:
		 * `true` for both `present` and `unreadable` reads, so it agrees with
		 * `size`, which counts present-but-unreadable blobs. A blob this device
		 * cannot decrypt still exists; `has()` says so.
		 */
		has(key: string): boolean {
			return read(key).state !== 'absent';
		},
		delete(key: string): void {
			inner.delete(key);
		},
		bulkDelete(keys: string[]): void {
			inner.bulkDelete(keys);
		},
		/**
		 * Walk every stored entry once, classified. The inner store is plaintext-
		 * typed, so each inner read is `present` with the raw stored value (blob or
		 * passthrough plaintext); `classify` turns that into the outward `present`
		 * or `unreadable`. One decrypt per entry, the bulk twin of `read()`.
		 */
		*reads(): IterableIterator<[string, KvStoredRead<T>]> {
			for (const [key, stored] of inner.reads()) {
				yield [key, classify(key, stored.val)];
			}
		},
		observe(handler: KvStoreChangeHandler<T>): () => void {
			changeHandlers.add(handler);
			return () => changeHandlers.delete(handler);
		},
		/**
		 * Activate encryption with a versioned keyring. The highest-version key
		 * becomes the current key for new encryptions. Decryption reads
		 * `getKeyVersion(blob)` to select the correct key from the keyring.
		 *
		 * There is no deactivation path. This is one-way by API surface. Calling
		 * again with a new keyring updates the active keys AND re-encrypts any
		 * entries that aren't already at the current key version.
		 *
		 * After this call, every decryptable entry is stored as ciphertext under
		 * the current-version key:
		 *
		 * - Plaintext entries → encrypted with the current-version key.
		 * - Ciphertext at a non-current version (decryptable via the keyring) →
		 *   decrypted and re-encrypted with the current-version key. This is how
		 *   key rotation upgrades at-rest data.
		 * - Ciphertext already at the current version → no-op.
		 * - Ciphertext whose key version is not in the keyring → skipped
		 *   (unreadable; left unchanged).
		 *
		 * @param keyring Map from version number to 32-byte encryption key
		 */
		activateEncryption(keyring: ReadonlyWorkspaceKeyring): void {
			if (keyring.size === 0)
				throw new Error('Keyring must contain at least one key');
			const previousEncryption = encryption;
			const nextVersion = Math.max(...keyring.keys());
			const nextKey = keyring.get(nextVersion);
			if (!nextKey) throw new Error(`Missing key for version ${nextVersion}`);
			const nextEncryption = {
				keyring,
				currentKey: nextKey,
				currentVersion: nextVersion,
			} satisfies EncryptionState;
			encryption = nextEncryption;

			// Walk every entry and converge it to the current key version. Three
			// cases, handled in priority order:
			//   1. Ciphertext already at currentVersion → no-op (cheap skip).
			//   2. Ciphertext at a non-current version that IS in the keyring →
			//      decrypt + re-encrypt with currentKey. This is how rotation
			//      upgrades at-rest data.
			//   3. Plaintext entries → encrypt with currentKey.
			// Ciphertext whose key version is not in the keyring is skipped
			// (unreadable; left as-is for a future activateEncryption that
			// includes it).
			//
			// Newly-readable entries (decryptable under nextEncryption but whose
			// version was NOT in previousEncryption's keyring) get a synthetic
			// `add` event so observers catch up. The check is a map lookup,
			// under authenticated crypto with immutable key versions,
			// "version was in previous keyring" ⇔ "was decryptable before",
			// for entries that decrypt under the new keyring.
			const newlyReadable = new Map<string, T>();
			const toRewrite: Array<{ key: string; val: T }> = [];
			for (const [key, entry] of inner.map) {
				const aad = textEncoder.encode(key);
				if (!isEncryptedBlob(entry.val)) {
					toRewrite.push({ key, val: entry.val as T });
					continue;
				}
				const version = getKeyVersion(entry.val);
				if (version === nextEncryption.currentVersion) continue;
				const val = decrypt(entry.val, aad, nextEncryption);
				if (val === undefined) continue;
				toRewrite.push({ key, val });
				const wasReadable = previousEncryption?.keyring.has(version) ?? false;
				if (!wasReadable) newlyReadable.set(key, val);
			}

			// One transaction for the whole pass. Filtered by observers via
			// REENCRYPT_ORIGIN. Downstream consumers don't see re-encryption
			// as a change (the decrypted value didn't change).
			if (toRewrite.length > 0) {
				inner.doc.transact(() => {
					for (const { key, val } of toRewrite)
						inner.set(key, toStored(key, val));
				}, REENCRYPT_ORIGIN);
			}

			if (newlyReadable.size === 0) return;
			const syntheticChanges = new Map<string, KvStoreChange<T>>();
			for (const [key, val] of newlyReadable)
				syntheticChanges.set(key, { action: 'add', newValue: val });
			for (const handler of changeHandlers)
				handler(syntheticChanges, undefined);
		},
		/**
		 * Number of stored entries after conflict resolution, **including**
		 * undecryptable blobs. This previously subtracted them, which made the
		 * count silently disagree with what storage held (the encrypted twin of
		 * the schema-edit silent drop). They are now visible via `reads()` and
		 * counted here, so the count equals what `reads()` yields.
		 */
		get size() {
			return inner.map.size;
		},
		/** The underlying Y.Array. Contains **ciphertext** when a key is active. */
		yarray: inner.yarray,
		/**
		 * Unregister the inner observer and release resources. Call when this
		 * wrapper is no longer needed but the underlying Y.Array continues to exist.
		 */
		[Symbol.dispose](): void {
			unobserveInner();
			inner[Symbol.dispose]();
		},
	};
}
