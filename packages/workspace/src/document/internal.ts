/**
 * Internal subpath: not part of `@epicenter/workspace`'s public API.
 *
 * Exports the `create*` factories that wrap a pre-constructed `ObservableKvStore`.
 * External consumers should use `attachTable` / `attachKv` from the package
 * root: those are the public Y.Doc-wiring entry points.
 *
 * The encrypted attachments in this same package reach in here because they
 * construct their own encrypted store and need the factory logic without the
 * Y.Doc wiring.
 * Awareness has no analogous encrypted path, so there's no reason to export
 * `createAwareness` here.
 */
import type { IndexedDbAttachment } from './attach-indexed-db.js';

export type InternalEncryptedIndexedDbAttachment = IndexedDbAttachment & {
	activateEncryption(keyring: ReadonlyMap<number, Uint8Array>): void;
};

export { createReadonlyTable, createTable } from './attach-table.js';
export { createKv } from './attach-kv.js';
