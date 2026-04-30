/**
 * attachEncryption: per-ydoc encryption coordinator.
 *
 * A workspace owns several `EncryptedYKeyValueLww` stores (one per table plus
 * the KV store). This attachment coordinates key application across all of
 * them: it derives a per-workspace HKDF keyring from base64 user keys and
 * calls `activateEncryption(keyring)` on every registered store in lockstep.
 *
 * ## Method-on-coordinator pattern
 *
 * The coordinator owns the method surface for attaching its sibling
 * primitives. Instead of top-level `attachEncryptedTable(ydoc, encryption, ...)`
 * exports, call the methods on the returned attachment:
 *
 * ```ts
 * const encryption = attachEncryption(ydoc);
 * const tables = encryption.attachTables(ydoc, defs);
 * const kv = encryption.attachKv(ydoc, defs);
 * ```
 *
 * The method names deliberately mirror the plaintext primitives
 * (`attachTable`, `attachTables`, `attachKv`) so the pattern reads
 * symmetrically: "encryption's attach-tables" vs "plain attach-tables."
 *
 * ## Registration model
 *
 * Each method creates the backing `EncryptedYKeyValueLww` store, registers it
 * with the coordinator, and returns the typed helper. The coordinator holds
 * the list and applies the current keyring (if any) to each new registrant
 * immediately: so registering after `applyKeys` has run does not leave the
 * store plaintext.
 *
 * ## Fingerprint dedup
 *
 * Auth token refreshes fire `onLogin` repeatedly with identical key material.
 * The attachment holds a `lastKeysFingerprint` so subsequent calls with the
 * same keys short-circuit before HKDF and per-store activation run. The
 * fingerprint is order-independent: reversed key arrays produce the same
 * fingerprint (see `encryptionKeysFingerprint`).
 *
 * ## Disposal
 *
 * The attachment registers a single `ydoc.on('destroy')` listener that
 * disposes every registered store and resolves `whenDisposed`. Callers tear
 * down encryption by calling `ydoc.destroy()`: the attachment does not
 * expose a standalone `dispose()` method.
 *
 * ## What this attachment does NOT do
 *
 * - It does not wipe CRDT state. Any future "wipe encrypted blobs" API needs
 *   to coordinate with persistence to be useful: design it alongside the
 *   consumer migration.
 * - It does not validate that every encryption-capable slot on the Y.Doc
 *   got registered. The caller owns the composition: if you pair a
 *   plaintext `attachTable` with `encryption.attachTable` targeting the
 *   *same slot name*, Yjs hands both calls the same underlying `Y.Array` and
 *   you get a silent plaintext-over-ciphertext race. The verb
 *   (`encryption.attachTable` vs plain `attachTable`) is the primary defense;
 *   review call sites accordingly. One slot name, one attach site, one intent.
 *
 * ## Why `workspaceId` is read from `ydoc.guid`
 *
 * By construction, the workspace Y.Doc's `guid` equals the workspace id
 * (`new Y.Doc({ guid: id })`). Taking a separate `workspaceId` parameter
 * would invite drift between the two. `deriveWorkspaceKey` uses the id as
 * an HKDF domain-separation label: it doesn't care whether the string is
 * the guid or an explicit id, only that the two agree.
 *
 * @module
 */

import type * as Y from 'yjs';
import { base64ToBytes, deriveWorkspaceKey } from '../shared/crypto/index.js';
import {
	createEncryptedYkvLww,
	type EncryptedYKeyValueLww,
} from '../shared/y-keyvalue/y-keyvalue-lww-encrypted.js';
import {
	type EncryptionKeys,
	encryptionKeysFingerprint,
} from './encryption-key.js';
import {
	type InferTableRow,
	type Table,
	type TableDefinition,
	type TableDefinitions,
	type Tables,
} from './attach-table.js';
import { type Kv, type KvDefinitions } from './attach-kv.js';
import { createKv, createTable } from './internal.js';
import { KV_KEY, TableKey } from './keys.js';

/**
 * The coordinator treats every registered store uniformly: it only calls
 * `activateEncryption(keyring)` and `dispose()`, neither of which depends on
 * the store's value type. `any` is the variance-friendly alias here.
 */
// biome-ignore lint/suspicious/noExplicitAny: variance
type AnyEncryptedStore = EncryptedYKeyValueLww<any>;

export type EncryptionAttachment = {
	/**
	 * Apply encryption keys to every registered store. Synchronous: HKDF via
	 * @noble/hashes and XChaCha20 via @noble/ciphers are both sync.
	 *
	 * On every call (including the first), every registered store walks its
	 * entries and converges them to the current-version key:
	 *
	 * - Plaintext entries → encrypted with the current-version key.
	 * - Ciphertext at a non-current version (but decryptable via the keyring)
	 *   → decrypted and re-encrypted with the current-version key.
	 * - Ciphertext already at the current version → no-op.
	 *
	 * This is how key rotation works: call `applyKeys` with the new keyring,
	 * and all at-rest data upgrades to the new key. The ciphertext upgrades
	 * propagate to peers via normal CRDT sync; eventually every device's live
	 * view contains only current-version ciphertext.
	 *
	 * Dedup: a second call with a fingerprint-identical keyring is a no-op.
	 * Order of the input array does not affect the fingerprint.
	 *
	 * Stores registered after this call will be auto-activated with the cached
	 * keyring at registration time.
	 */
	applyKeys(keys: EncryptionKeys): void;

	/**
	 * Register a store for encryption coordination.
	 *
	 * If keys have already been applied, the store is activated immediately
	 * with the cached keyring. Otherwise it is queued for the next
	 * `applyKeys` call.
	 *
	 * @internal Called by the coordinator's own `attachTable` / `attachKv`
	 * methods and by test setup, not by application code.
	 */
	register(store: AnyEncryptedStore): void;

	/**
	 * Attach an encrypted table: mirror of the plaintext `attachTable(ydoc,
	 * name, def)` but with the store registered for encryption coordination.
	 */
	attachTable<
		// biome-ignore lint/suspicious/noExplicitAny: variance-friendly: defineTable already constrains schemas
		TTableDefinition extends TableDefinition<any>,
	>(
		ydoc: Y.Doc,
		name: string,
		definition: TTableDefinition,
	): Table<InferTableRow<TTableDefinition>>;

	/**
	 * Batch sugar over `attachTable`: one encrypted store per entry, keyed by
	 * name. Mirror of the plaintext `attachTables(ydoc, defs)`.
	 */
	attachTables<T extends TableDefinitions>(
		ydoc: Y.Doc,
		definitions: T,
	): Tables<T>;

	/**
	 * Attach the encrypted KV singleton. Mirror of the plaintext
	 * `attachKv(ydoc, defs)`.
	 */
	attachKv<T extends KvDefinitions>(ydoc: Y.Doc, definitions: T): Kv<T>;

	/** Resolves when the Y.Doc is destroyed and every store has been disposed. */
	readonly whenDisposed: Promise<unknown>;
};

/**
 * Create an encryption coordinator bound to `ydoc`.
 *
 * The returned coordinator owns `attachTable` / `attachTables` / `attachKv`
 * methods: call them to register encrypted stores. Call `applyKeys(keys)`
 * after login (or whenever the auth session produces keys) to activate
 * encryption across every registered store.
 */
export function attachEncryption(ydoc: Y.Doc): EncryptionAttachment {
	const stores: AnyEncryptedStore[] = [];
	const workspaceId = ydoc.guid;

	/** Cache the last-applied keyring so late-registered stores can activate. */
	let cachedKeyring: Map<number, Uint8Array> | undefined;
	/** Fingerprint of the last-applied encryption keys for same-key dedup. */
	let lastKeysFingerprint: string | undefined;

	let resolveDisposed!: () => void;
	const whenDisposed = new Promise<void>((resolve) => {
		resolveDisposed = resolve;
	});

	ydoc.on('destroy', () => {
		for (const store of stores) store.dispose();
		resolveDisposed();
	});

	const attachment: EncryptionAttachment = {
		applyKeys(keys) {
			const fingerprint = encryptionKeysFingerprint(keys);
			if (fingerprint === lastKeysFingerprint) return;
			lastKeysFingerprint = fingerprint;

			const keyring = new Map<number, Uint8Array>();
			for (const { version, userKeyBase64 } of keys) {
				const userKey = base64ToBytes(userKeyBase64);
				keyring.set(version, deriveWorkspaceKey(userKey, workspaceId));
			}
			cachedKeyring = keyring;
			for (const store of stores) store.activateEncryption(keyring);
		},
		register(store) {
			stores.push(store);
			if (cachedKeyring !== undefined) store.activateEncryption(cachedKeyring);
		},
		attachTable(ydoc, name, definition) {
			const store = createEncryptedYkvLww(ydoc, TableKey(name));
			attachment.register(store);
			return createTable(store, definition, name);
		},
		attachTables(ydoc, definitions) {
			return Object.fromEntries(
				Object.entries(definitions).map(([name, def]) => [
					name,
					attachment.attachTable(ydoc, name, def),
				]),
			) as Tables<typeof definitions>;
		},
		attachKv(ydoc, definitions) {
			const store = createEncryptedYkvLww(ydoc, KV_KEY);
			attachment.register(store);
			return createKv(store, definitions);
		},
		whenDisposed,
	};

	return attachment;
}
