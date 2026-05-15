/**
 * attachEncryption: per-ydoc encryption coordinator.
 *
 * A workspace owns several `EncryptedYKeyValueLww` stores (one per table plus
 * the KV store). This attachment derives a per-workspace HKDF keyring at
 * attach time and calls `activateEncryption(keyring)` on each store before
 * the caller gets it back.
 *
 * ## Method-on-coordinator pattern
 *
 * The coordinator owns the method surface for attaching its sibling
 * primitives. Instead of top-level `attachEncryptedTable(ydoc, encryption, ...)`
 * exports, call the methods on the returned attachment:
 *
 * ```ts
 * const encryption = attachEncryption(ydoc, { keyring: () => subjectKeyring });
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
 * `keyring` is a callback into whoever owns identity. The coordinator calls
 * it synchronously at every `attachTable` / `attachKv` site, derives the
 * per-workspace keyring, and activates the store. The keyring is not cached
 * on the attachment: each attach call is its own derivation, which keeps
 * state out of this layer entirely.
 *
 * Same-subject identity updates (key rotation, profile edits) do not flow
 * through this attachment. Authenticated apps reload the page on
 * different-subject transitions; same-subject updates are observed lazily
 * via the `keyring` callback the next time it runs.
 *
 * ## Local owner concerns live on `createLocalOwner`
 *
 * Encrypted IndexedDB, owner-scoped BroadcastChannel, and local-data wipe are
 * identity-scoped (one signed-in user) rather than ydoc-scoped, so they live
 * on `createLocalOwner` (`./local-owner.ts`). Daemons that only need
 * encryption call `attachEncryption` directly; browsers go through
 * `LocalOwner`, which delegates encryption to this function.
 *
 * ## Disposal
 *
 * Each attached store hooks `ydoc.once('destroy', ...)` at attach time,
 * mirroring the plaintext `attachTable` / `attachKv` primitives. Callers tear
 * down encryption by calling `ydoc.destroy()`: the attachment does not expose
 * a standalone `dispose()` method.
 *
 * ## What this attachment does NOT do
 *
 * - It does not wipe CRDT state. `LocalOwner.wipeLocalYjsData` owns that.
 * - It does not validate that every encryption-capable slot on the Y.Doc got
 *   registered. The caller owns the composition: if you pair a plaintext
 *   `attachTable` with `encryption.attachTable` targeting the *same slot
 *   name*, Yjs hands both calls the same underlying `Y.Array` and you get a
 *   silent plaintext-over-ciphertext race. The verb (`encryption.attachTable`
 *   vs plain `attachTable`) is the primary defense; review call sites
 *   accordingly. One slot name, one attach site, one intent.
 *
 * ## Why `workspaceId` is read from `ydoc.guid`
 *
 * By construction, the workspace Y.Doc's `guid` equals the workspace id
 * (`new Y.Doc({ guid: id })`). Taking a separate `workspaceId` parameter
 * would invite drift between the two. `deriveWorkspaceKey` uses the id as an
 * HKDF domain-separation label: it doesn't care whether the string is the
 * guid or an explicit id, only that the two agree.
 *
 * @module
 */

import type { SubjectKeyring } from '@epicenter/encryption';
import type * as Y from 'yjs';
import {
	createEncryptedYkvLww,
	type EncryptedYKeyValueLww,
} from '../shared/y-keyvalue/y-keyvalue-lww-encrypted.js';
import { createKv, type Kv, type KvDefinitions } from './attach-kv.js';
import {
	createReadonlyTable,
	createTable,
	type InferTableRow,
	type ReadonlyTable,
	type ReadonlyTables,
	type Table,
	type TableDefinition,
	type TableDefinitions,
	type Tables,
} from './attach-table.js';
import { deriveWorkspaceKeyring } from './derive-workspace-keyring.js';
import { KV_KEY, TableKey } from './keys.js';

export type AttachEncryptionOptions = {
	/**
	 * Lazy reader for the current subject keyring.
	 *
	 * Called synchronously at every `attachTable` / `attachKv` site. Throw if
	 * no keyring is available (e.g. signed-out): a throw here means the
	 * workspace outlived its signed-in scope, which is a caller bug.
	 */
	keyring: () => SubjectKeyring;
};

export type EncryptionAttachment = {
	/**
	 * Attach an encrypted table to the coordinator's Y.Doc. The store is
	 * activated with the current keyring (via `keyring()`) before being
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
};

/**
 * Create an encryption coordinator bound to `ydoc`.
 *
 * The returned coordinator owns `attachTable` / `attachTables` / `attachKv`
 * methods: call them to register encrypted resources. The coordinator reads
 * `options.keyring()` synchronously at each registration site and
 * activates the resource before returning it.
 */
export function attachEncryption(
	ydoc: Y.Doc,
	options: AttachEncryptionOptions,
): EncryptionAttachment {
	const workspaceId = ydoc.guid;

	// biome-ignore lint/suspicious/noExplicitAny: variance
	function attachStore(key: string): EncryptedYKeyValueLww<any> {
		const store = createEncryptedYkvLww(ydoc, key);
		ydoc.once('destroy', () => store[Symbol.dispose]());
		store.activateEncryption(
			deriveWorkspaceKeyring(options.keyring(), workspaceId),
		);
		return store;
	}

	const attachment: EncryptionAttachment = {
		attachTable(name, definition) {
			return createTable(attachStore(TableKey(name)), definition, name);
		},
		attachReadonlyTable(name, definition) {
			return createReadonlyTable(attachStore(TableKey(name)), definition, name);
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
			return createKv(attachStore(KV_KEY), definitions);
		},
	};

	return attachment;
}
