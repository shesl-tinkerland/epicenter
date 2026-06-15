/// <reference lib="dom" />

/**
 * `attachEncryptedIndexedDb`: encrypted IndexedDB persistence for a Y.Doc's
 * update log.
 *
 * ## Keyring rotation contract: snapshot-by-design
 *
 * `keyring()` is read exactly once at attach. The newest version becomes the
 * write key for every row this attachment persists; the full derived keyring
 * is kept for decryption, selected per row by the version byte in the blob
 * header. There is no live rotation surface (no `activateEncryption`
 * equivalent), on purpose:
 *
 * - The inner encryption layer snapshots too. `createWorkspace` derives its
 *   keyring once at construction, so the Yjs updates persisted here already
 *   contain value blobs frozen at the construction-time key version.
 *   Re-keying only this outer envelope mid-session would upgrade nothing.
 * - The update log converges lazily, and that is enough. After the next
 *   attach every new row carries the rotated write version; old-version rows
 *   are rewritten only when the log crosses the compaction threshold
 *   (compaction encrypts a fresh snapshot and drops the older rows). Below
 *   the threshold old-version rows simply remain, which is safe because
 *   rotated-out versions stay in the keyring. An explicit rotation method
 *   would duplicate what compaction already does.
 * - Contrast with `createEncryptedYkvLww`, which does expose re-callable
 *   `activateEncryption`: its at-rest data is the CRDT itself, synced across
 *   devices, so it needs an explicit walk to upgrade durable entries. This
 *   store is a per-device cache that can be rebuilt from the doc at any time.
 *
 * The contract leans on the `Keyring` invariant that rotated-out versions
 * stay in the keyring (see `@epicenter/encryption` `Keyring`). A row whose
 * version is missing from the attach-time keyring fails decryption: at
 * initial load that rejects `whenLoaded`; during compaction it logs
 * `CompactionFailed` and leaves rows un-trimmed.
 *
 * Known mid-session rotation seam: if another tab attaches after a rotation
 * and writes newer-version rows into the shared database, a tab still
 * holding the pre-rotation snapshot cannot decrypt them, so its compaction
 * degrades (logged, retried, rows accumulate) until that tab re-attaches.
 * Live updates still flow over BroadcastChannel and nothing is lost; the
 * next attach in that tab recovers fully.
 *
 * @module
 */

import {
	decryptBytes,
	type EncryptedBlob,
	encryptBytes,
	type Keyring,
} from '@epicenter/encryption';
import * as idb from 'lib0/indexeddb';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { createLogger, type Logger } from 'wellcrafted/logger';
import { clearDocument } from 'y-indexeddb';
import type * as Y from 'yjs';
import { applyUpdateV2, encodeStateAsUpdateV2, transact } from 'yjs';
import { debounce } from '../shared/debounce.js';
import type { IndexedDbAttachment } from './attach-indexed-db.js';
import { deriveWorkspaceKeyring } from './derive-workspace-keyring.js';

const UPDATES_STORE_NAME = 'updates';
const CUSTOM_STORE_NAME = 'custom';
const PREFERRED_TRIM_SIZE = 500;
/** Coalesce a burst of over-threshold writes into one compaction run. */
const COMPACTION_DEBOUNCE_MS = 1_000;
const textEncoder = new TextEncoder();

/** Background failures logged by attachEncryptedIndexedDb. */
export const EncryptedIndexedDbError = defineErrors({
	/**
	 * A single encrypted update failed to write. The in-memory ydoc still has
	 * the update, so the next reload from this database will diverge from what
	 * was last persisted.
	 */
	PersistUpdateFailed: ({
		cause,
		databaseName,
	}: {
		cause: unknown;
		databaseName: string;
	}) => ({
		message: `[attachEncryptedIndexedDb] failed to persist update to '${databaseName}': ${extractErrorMessage(cause)}`,
		cause,
		databaseName,
	}),
	/**
	 * Debounced compaction throw: pending updates remain un-merged, and the
	 * trim threshold check will retry on the next write.
	 */
	CompactionFailed: ({
		cause,
		databaseName,
	}: {
		cause: unknown;
		databaseName: string;
	}) => ({
		message: `[attachEncryptedIndexedDb] compaction failed for '${databaseName}': ${extractErrorMessage(cause)}`,
		cause,
		databaseName,
	}),
});
export type EncryptedIndexedDbError = InferErrors<
	typeof EncryptedIndexedDbError
>;

type EncryptedIndexedDbOptions = {
	databaseName: string;
	/**
	 * Lazy reader for the current owner keyring. Called exactly once at
	 * attach time to derive the per-`ydoc.guid` workspace keyring; the
	 * newest version becomes the write key for the lifetime of this
	 * attachment. Rotations are picked up at the next attach, not live.
	 * See the module doc for the full rotation contract.
	 */
	keyring: () => Keyring;
	/**
	 * Logger for background failures (persistence write rejections, compaction
	 * throws). Defaults to a console-backed logger with source
	 * `attachEncryptedIndexedDb`.
	 */
	log?: Logger;
};

export function attachEncryptedIndexedDb(
	ydoc: Y.Doc,
	{
		databaseName,
		keyring,
		log = createLogger('attachEncryptedIndexedDb'),
	}: EncryptedIndexedDbOptions,
): IndexedDbAttachment {
	const workspaceKeyring = deriveWorkspaceKeyring(keyring(), ydoc.guid);
	if (workspaceKeyring.size === 0) {
		throw new Error(
			'Cannot attach encrypted IndexedDB provider: keyring() returned no usable keys.',
		);
	}
	const writeVersion = Math.max(...workspaceKeyring.keys());
	const writeBytes = workspaceKeyring.get(writeVersion)!;
	let db: IDBDatabase | undefined;
	let dbref = 0;
	let dbsize = 0;

	const aad = textEncoder.encode(`yjs-update-v2:${ydoc.guid}`);
	const {
		promise: whenLoaded,
		resolve: resolveLoaded,
		reject: rejectLoaded,
	} = Promise.withResolvers<void>();
	// Swallow rejection when no consumer awaits (dispose lands before load,
	// or after the consumer already resolved their wait).
	whenLoaded.catch(() => {});
	const { promise: whenDisposed, resolve: resolveDisposed } =
		Promise.withResolvers<void>();

	const dbPromise = idb.openDB(databaseName, (database) => {
		idb.createStores(database, [
			[UPDATES_STORE_NAME, { autoIncrement: true }],
			[CUSTOM_STORE_NAME],
		]);
	});

	const attachment = {
		whenLoaded,
		clearLocal: () => clearDocument(databaseName),
		whenDisposed,
	} satisfies IndexedDbAttachment;

	async function addEncryptedUpdate(
		updatesStore: IDBObjectStore,
		update: Uint8Array,
	): Promise<void> {
		dbsize += 1;
		const ciphertext = encryptBytes({
			key: writeBytes,
			keyVersion: writeVersion,
			plaintext: update,
			aad,
		});
		// lib0's `addAutoKey` types `item` narrower than IDB structured-clone
		// accepts. Uint8Array is supported at runtime; the cast widens the type
		// signature, not the runtime contract.
		await idb.addAutoKey(updatesStore, ciphertext as unknown as ArrayBuffer);
	}

	async function fetchUpdates(
		beforeApplyUpdates: (
			updatesStore: IDBObjectStore,
		) => void | Promise<void> = () => {},
		afterApplyUpdates: (
			updatesStore: IDBObjectStore,
		) => void | Promise<void> = () => {},
	): Promise<IDBObjectStore> {
		if (db === undefined) {
			throw new Error(
				'Cannot fetch encrypted IndexedDB updates before DB open.',
			);
		}
		const [updatesStore] = idb.transact(db, [UPDATES_STORE_NAME]);
		if (updatesStore === undefined) {
			throw new Error('Encrypted IndexedDB updates store is missing.');
		}
		const encryptedUpdates = (await idb.getAll(
			updatesStore,
			IDBKeyRange.lowerBound(dbref, false),
		)) as EncryptedBlob[];
		if (!ydoc.isDestroyed) {
			await beforeApplyUpdates(updatesStore);
			transact(
				ydoc,
				() => {
					for (const blob of encryptedUpdates) {
						applyUpdateV2(
							ydoc,
							decryptBytes({ keyring: workspaceKeyring, blob, aad }),
							attachment,
						);
					}
				},
				attachment,
				false,
			);
			await afterApplyUpdates(updatesStore);
		}
		const lastKey = (await idb.getLastKey(updatesStore)) as number | null;
		dbref = lastKey === null ? 0 : lastKey + 1;
		dbsize = await idb.count(updatesStore);
		return updatesStore;
	}

	// Debounced compaction: merge any pending updates, then if the running count
	// is still over the trim threshold, encrypt a snapshot and drop the older
	// per-update rows. The threshold check inside survives a concurrent
	// cross-tab compaction lowering `dbsize` between schedule and fire.
	async function compactUpdates(): Promise<void> {
		const updatesStore = await fetchUpdates();
		if (dbsize < PREFERRED_TRIM_SIZE) return;
		await addEncryptedUpdate(updatesStore, encodeStateAsUpdateV2(ydoc));
		await idb.del(updatesStore, IDBKeyRange.upperBound(dbref, true));
		dbsize = await idb.count(updatesStore);
	}

	const compactAfterDebounce = debounce(() => {
		compactUpdates().catch((cause) => {
			log.warn(
				EncryptedIndexedDbError.CompactionFailed({ cause, databaseName }),
			);
		});
	}, COMPACTION_DEBOUNCE_MS);

	const handleUpdate = (update: Uint8Array, origin: unknown) => {
		if (db === undefined || origin === attachment) return;
		const [updatesStore] = idb.transact(db, [UPDATES_STORE_NAME]);
		if (updatesStore === undefined) return;
		addEncryptedUpdate(updatesStore, update).catch((cause) => {
			log.warn(
				EncryptedIndexedDbError.PersistUpdateFailed({ cause, databaseName }),
			);
		});
		if (dbsize >= PREFERRED_TRIM_SIZE) compactAfterDebounce();
	};

	dbPromise
		.then(async (openedDb) => {
			db = openedDb;
			await fetchUpdates(
				(updatesStore) =>
					addEncryptedUpdate(updatesStore, encodeStateAsUpdateV2(ydoc)),
				() => {
					if (!ydoc.isDestroyed) resolveLoaded();
				},
			);
		})
		.catch((error: unknown) => {
			rejectLoaded(error);
		});

	ydoc.on('updateV2', handleUpdate);
	ydoc.once('destroy', async () => {
		compactAfterDebounce.cancel();
		ydoc.off('updateV2', handleUpdate);
		// Settle the load barrier if destroy lands before the boot chain
		// resolves it. No-op when `whenLoaded` is already settled.
		rejectLoaded(
			new Error(
				'[attachEncryptedIndexedDb] doc destroyed before load completed',
			),
		);
		try {
			(await dbPromise).close();
		} finally {
			resolveDisposed();
		}
	});

	return attachment;
}
