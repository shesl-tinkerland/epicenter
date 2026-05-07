/**
 * attachEncryption: per-ydoc encryption coordinator.
 *
 * A workspace owns several `EncryptedYKeyValueLww` stores (one per table plus
 * the KV store). This attachment derives a per-workspace HKDF keyring at
 * registration time and calls `activateEncryption(keyring)` on each store
 * before the caller gets it back.
 *
 * ## Method-on-coordinator pattern
 *
 * The coordinator owns the method surface for attaching its sibling
 * primitives. Instead of top-level `attachEncryptedTable(ydoc, encryption, ...)`
 * exports, call the methods on the returned attachment:
 *
 * ```ts
 * const encryption = attachEncryption(ydoc, { encryptionKeys: () => keys });
 * const tables = encryption.attachTables(defs);
 * const kv = encryption.attachKv(defs);
 * ```
 *
 * The method names deliberately mirror the plaintext primitives
 * (`attachTable`, `attachTables`, `attachKv`) so the pattern reads
 * symmetrically: "encryption's attach-tables" vs "plain attach-tables."
 *
 * ## Key source: lazy callback
 *
 * `encryptionKeys` is a callback into whoever owns identity.
 * The coordinator calls it synchronously at every `attachTable` / `attachKv` /
 * `attachIndexedDb` site, derives the keyring, and activates the store. The
 * keyring is not cached on the attachment: each registration is its own
 * derivation, which keeps state out of this layer entirely.
 *
 * Same-user identity updates (key rotation, profile edits) do not flow
 * through this attachment. The session lifecycle reloads the page on
 * different-user transitions; same-user updates are observed lazily via
 * the `encryptionKeys` callback the next time it runs.
 *
 * ## Disposal
 *
 * The attachment registers a single `ydoc.on('destroy')` listener that
 * disposes every registered store. Callers tear down encryption by calling
 * `ydoc.destroy()`: the attachment does not expose a standalone `dispose()`
 * method.
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

import {
	base64ToBytes,
	deriveWorkspaceKey,
	type EncryptionKeys,
} from '@epicenter/encryption';
import type * as Y from 'yjs';
import {
	createEncryptedYkvLww,
	type EncryptedYKeyValueLww,
} from '../shared/y-keyvalue/y-keyvalue-lww-encrypted.js';
import {
	attachEncryptedProvider,
	type IndexedDbAttachment,
} from './attach-indexed-db.js';
import type { Kv, KvDefinitions } from './attach-kv.js';
import type {
	InferTableRow,
	ReadonlyTable,
	ReadonlyTables,
	Table,
	TableDefinition,
	TableDefinitions,
	Tables,
} from './attach-table.js';
import { createKv, createReadonlyTable, createTable } from './internal.js';
import { KV_KEY, TableKey } from './keys.js';
import { createOwnedYjsKey } from './local-yjs-key.js';

/**
 * The coordinator treats every registered store uniformly: it only calls
 * `activateEncryption(keyring)` and `dispose()`, neither of which depends on
 * the store's value type. `any` is the variance-friendly alias here.
 */
// biome-ignore lint/suspicious/noExplicitAny: variance
type AnyEncryptedStore = EncryptedYKeyValueLww<any>;

export type AttachEncryptionOptions = {
	/**
	 * Lazy reader for the current user's encryption keys.
	 *
	 * Called synchronously at every `attachTable` / `attachKv` /
	 * `attachIndexedDb` site. Throw if no keys are available (e.g. signed-out):
	 * a throw here means the workspace outlived its signed-in scope, which is a
	 * caller bug.
	 */
	encryptionKeys: () => EncryptionKeys;
};

export type EncryptionAttachment = {
	/**
	 * Attach an encrypted table to the coordinator's Y.Doc. The store is
	 * activated with the current keyring (via `encryptionKeys()`) before being
	 * returned.
	 */
	attachTable<
		// biome-ignore lint/suspicious/noExplicitAny: variance-friendly: defineTable already constrains schemas
		TTableDefinition extends TableDefinition<any>,
	>(
		name: string,
		definition: TTableDefinition,
	): Table<InferTableRow<TTableDefinition>>;

	attachReadonlyTable<
		// biome-ignore lint/suspicious/noExplicitAny: variance-friendly
		TTableDefinition extends TableDefinition<any>,
	>(
		name: string,
		definition: TTableDefinition,
	): ReadonlyTable<InferTableRow<TTableDefinition>>;

	/**
	 * Batch sugar over `attachTable`: one encrypted store per entry, keyed by
	 * name.
	 */
	attachTables<T extends TableDefinitions>(definitions: T): Tables<T>;

	attachReadonlyTables<T extends TableDefinitions>(
		definitions: T,
	): ReadonlyTables<T>;

	/**
	 * Attach the encrypted KV singleton to the coordinator's Y.Doc.
	 */
	attachKv<T extends KvDefinitions>(definitions: T): Kv<T>;

	/**
	 * Attach encrypted local IndexedDB persistence for a root or child Y.Doc.
	 *
	 * Reads keys via `options.encryptionKeys()` at attach time and binds the derived
	 * keyring to the provider. Same-user key rotation is not observed by the
	 * provider after this point; cross-user transitions reload the page.
	 */
	attachIndexedDb(
		targetYdoc: Y.Doc,
		opts: { userId: string },
	): IndexedDbAttachment;
};

/**
 * Create an encryption coordinator bound to `ydoc`.
 *
 * The returned coordinator owns `attachTable` / `attachTables` / `attachKv` /
 * `attachIndexedDb` methods: call them to register encrypted resources. The
 * coordinator reads `options.encryptionKeys()` synchronously at each registration
 * site and activates the resource before returning it.
 */
export function attachEncryption(
	ydoc: Y.Doc,
	options: AttachEncryptionOptions,
): EncryptionAttachment {
	const stores: AnyEncryptedStore[] = [];
	const workspaceId = ydoc.guid;

	ydoc.on('destroy', () => {
		for (const store of stores) store.dispose();
	});

	function deriveKeyring(
		keys: EncryptionKeys,
		targetWorkspaceId: string,
	): Map<number, Uint8Array> {
		const keyring = new Map<number, Uint8Array>();
		for (const { version, userKeyBase64 } of keys) {
			const userKey = base64ToBytes(userKeyBase64);
			keyring.set(version, deriveWorkspaceKey(userKey, targetWorkspaceId));
		}
		return keyring;
	}

	function register(store: AnyEncryptedStore): void {
		stores.push(store);
		store.activateEncryption(
			deriveKeyring(options.encryptionKeys(), workspaceId),
		);
	}

	const attachment: EncryptionAttachment = {
		attachTable(name, definition) {
			const store = createEncryptedYkvLww(ydoc, TableKey(name));
			register(store);
			return createTable(store, definition, name);
		},
		attachReadonlyTable(name, definition) {
			const store = createEncryptedYkvLww(ydoc, TableKey(name));
			register(store);
			return createReadonlyTable(store, definition, name);
		},
		attachTables(definitions) {
			return Object.fromEntries(
				Object.entries(definitions).map(([name, def]) => [
					name,
					attachment.attachTable(name, def),
				]),
			) as Tables<typeof definitions>;
		},
		attachReadonlyTables(definitions) {
			return Object.fromEntries(
				Object.entries(definitions).map(([name, def]) => [
					name,
					attachment.attachReadonlyTable(name, def),
				]),
			) as ReadonlyTables<typeof definitions>;
		},
		attachKv(definitions) {
			const store = createEncryptedYkvLww(ydoc, KV_KEY);
			register(store);
			return createKv(store, definitions);
		},
		attachIndexedDb(targetYdoc, { userId }) {
			return attachEncryptedProvider(targetYdoc, {
				databaseName: createOwnedYjsKey(userId, targetYdoc.guid),
				keyring: deriveKeyring(options.encryptionKeys(), targetYdoc.guid),
			});
		},
	};

	return attachment;
}
