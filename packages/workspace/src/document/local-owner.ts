/// <reference lib="dom" />

/**
 * Browser-local owner facade for an authenticated workspace session.
 *
 * Auth calls the server-issued identity label a `subject` because it derives
 * a `SubjectKeyring`. This package calls the same value `ownerId` once it is
 * used to name IndexedDB, BroadcastChannel, and wipe boundaries.
 *
 * Daemons do not construct an owner. They call `attachEncryption` directly
 * with `keyring` and persist through the filesystem instead of IndexedDB.
 */

import type { SubjectKeyring } from '@epicenter/encryption';
import { clearDocument } from 'y-indexeddb';
import type * as Y from 'yjs';
import { attachBroadcastChannelWithKey } from './attach-broadcast-channel.js';
import { attachEncryptedIndexedDb } from './attach-encrypted-indexed-db.js';
import { attachEncryption } from './attach-encryption.js';
import { createOwnedYjsKey, getOwnedYjsPrefix } from './local-yjs-key.js';

export type LocalOwner = ReturnType<typeof createLocalOwner>;

export function createLocalOwner({
	ownerId,
	keyring,
}: {
	/**
	 * Stable local owner label for browser-local workspace data.
	 *
	 * Callers usually pass `auth.state.localIdentity.subject` here. The rename
	 * is intentional: auth derives keys for a subject; workspace storage belongs
	 * to an owner.
	 */
	ownerId: string;
	keyring: () => SubjectKeyring;
}) {
	return {
		/**
		 * Attach per-ydoc encrypted tables and KV. Thin delegate to the free
		 * `attachEncryption(ydoc, { keyring })`; browsers go through the owner
		 * so the keyring callback never has to be re-passed.
		 */
		attachEncryption(ydoc: Y.Doc) {
			return attachEncryption(ydoc, { keyring });
		},
		/**
		 * Attach encrypted local IndexedDB persistence. The database name is
		 * `createOwnedYjsKey(ownerId, ydoc.guid)`. Another signed-in owner in
		 * the same browser profile gets a different database name for the same
		 * document guid.
		 */
		attachIndexedDb(ydoc: Y.Doc) {
			return attachEncryptedIndexedDb(ydoc, {
				databaseName: createOwnedYjsKey(ownerId, ydoc.guid),
				keyring,
			});
		},
		/**
		 * Attach owner-scoped cross-tab BroadcastChannel sync. Two signed-in
		 * subjects in the same browser profile cannot exchange plaintext
		 * updates through BroadcastChannel.
		 */
		attachBroadcastChannel(ydoc: Y.Doc) {
			attachBroadcastChannelWithKey(ydoc, createOwnedYjsKey(ownerId, ydoc.guid));
		},
		/**
		 * Delete every owner-scoped IndexedDB database currently visible to
		 * this browser profile, plus any explicitly named ones. Use from
		 * `wipe()` paths on sign-out so the next signed-in subject starts
		 * from a clean slate.
		 */
		async wipeLocalYjsData(ydocGuids: Iterable<string> = []) {
			const prefix = getOwnedYjsPrefix(ownerId);
			const names = new Set<string>();

			for (const guid of ydocGuids) {
				names.add(createOwnedYjsKey(ownerId, guid));
			}

			if ('databases' in indexedDB) {
				const databases = await indexedDB.databases().catch(() => []);
				for (const database of databases) {
					if (typeof database.name !== 'string') continue;
					if (!database.name.startsWith(prefix)) continue;
					names.add(database.name);
				}
			}

			await Promise.all([...names].map((name) => clearDocument(name)));
		},
	};
}
