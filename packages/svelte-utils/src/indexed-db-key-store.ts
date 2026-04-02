import type { UserKeyStore, EncryptionKeysJson } from '@epicenter/workspace';
import { openDB, type DBSchema } from 'idb';

const DB_NAME = 'epicenter-key-store';

/**
 * Explicit name to avoid confusion with IndexedDB's own "key" concept.
 *
 * `db.get('encryption-keys', storageKey)` reads unambiguously vs
 * `db.get('keys', storageKey)` which looks like "get keys by key."
 *
 * @see https://github.com/jakearchibald/idb — store names should describe
 *   what's stored, not the storage mechanism.
 */
const STORE_NAME = 'encryption-keys' as const;

/**
 * Uses `type` intersection instead of `interface extends DBSchema` to match
 * codebase conventions. The `idb` library idiomatically uses interfaces, but
 * the intersection + mapped type approach is equivalent and keeps the store
 * name coupled to the `STORE_NAME` constant.
 */
type KeyCacheDB = DBSchema & {
	[K in typeof STORE_NAME]: {
		key: string;
		value: string;
	};
};

/**
 * Lazily open (or create) the shared IndexedDB database for key caching.
 *
 * The database has a single object store with no key path—entries are
 * keyed by the caller-provided `storageKey` string. Each app gets its
 * own key so multiple apps on the same origin don't collide.
 */
const dbPromise = openDB<KeyCacheDB>(DB_NAME, 1, {
	upgrade(db) {
		db.createObjectStore(STORE_NAME);
	},
});

/**
 * Create a `UserKeyStore` backed by IndexedDB.
 *
 * Survives tab closes, page refreshes, and browser restarts—unlike
 * `sessionStorage` which clears when the tab closes. The key persists
 * until explicitly cleared (usually on sign-out).
 *
 * @param storageKey - Unique key within the shared store, typically
 *   `'{appName}:encryption-key'` to avoid collisions across apps on
 *   the same origin.
 *
 * @example
 * ```typescript
 * import { createIndexedDbKeyStore } from '@epicenter/svelte-utils';
 *
 * export const userKeyStore = createIndexedDbKeyStore('honeycrisp:encryption-key');
 * ```
 */
export function createIndexedDbKeyStore(storageKey: string): UserKeyStore {
	return {
		async set(userKeyBase64) {
			const db = await dbPromise;
			await db.put(STORE_NAME, userKeyBase64, storageKey);
		},
		async get() {
			const db = await dbPromise;
			return ((await db.get(STORE_NAME, storageKey)) ?? null) as EncryptionKeysJson | null;
		},
		async delete() {
			const db = await dbPromise;
			await db.delete(STORE_NAME, storageKey);
		},
	};
}
