/// <reference lib="dom" />

/**
 * createLocalOwner: identity-scoped facade for authenticated browser
 * workspaces.
 *
 * One owner per signed-in user session. Every browser-local Yjs artifact
 * (IndexedDB database name, BroadcastChannel key, wipe namespace) is keyed by
 * `(userId, ydocGuid)`, and every encrypted resource is bound to the same
 * user's encryption keys. The owner is the one named place that knows the
 * pair.
 *
 * Daemons do not construct an owner: they call `attachEncryption` directly
 * with just `encryptionKeys` and persist via filesystem instead of IDB.
 */

import type { EncryptionKeys } from '@epicenter/encryption';
import { clearDocument } from 'y-indexeddb';
import type * as Y from 'yjs';
import { attachBroadcastChannelWithKey } from './attach-broadcast-channel.js';
import { attachEncryptedIndexedDb } from './attach-encrypted-indexed-db.js';
import { attachEncryption } from './attach-encryption.js';
import { createOwnedYjsKey } from './local-yjs-key.js';

export type LocalOwner = ReturnType<typeof createLocalOwner>;

export function createLocalOwner({
	userId,
	encryptionKeys,
}: {
	userId: string;
	encryptionKeys: () => EncryptionKeys;
}) {
	return {
		/**
		 * Attach per-ydoc encrypted tables and KV. Thin delegate to the free
		 * `attachEncryption(ydoc, { encryptionKeys })`; browsers go through
		 * the owner so the encryption keys never have to be re-passed.
		 */
		attachEncryption(ydoc: Y.Doc) {
			return attachEncryption(ydoc, { encryptionKeys });
		},
		/**
		 * Attach encrypted local IndexedDB persistence. The database name is
		 * `createOwnedYjsKey(userId, ydoc.guid)` so other signed-in users on
		 * the same browser profile cannot read this user's persisted CRDT
		 * state.
		 */
		attachIndexedDb(ydoc: Y.Doc) {
			return attachEncryptedIndexedDb(ydoc, {
				databaseName: createOwnedYjsKey(userId, ydoc.guid),
				encryptionKeys,
			});
		},
		/**
		 * Attach owner-scoped cross-tab BroadcastChannel sync. Two signed-in
		 * users in the same browser profile cannot exchange plaintext updates
		 * through BroadcastChannel.
		 */
		attachBroadcastChannel(ydoc: Y.Doc) {
			attachBroadcastChannelWithKey(ydoc, createOwnedYjsKey(userId, ydoc.guid));
		},
		/**
		 * Delete every owner-scoped IndexedDB database currently visible to
		 * this browser profile, plus any explicitly named ones. Use from
		 * `wipe()` paths on sign-out so the next signed-in user starts from a
		 * clean slate.
		 */
		async wipeLocalYjsData(ydocGuids: Iterable<string> = []) {
			const prefix = `epicenter.v1.user.${userId}.yjs.`;
			const names = new Set<string>();

			for (const guid of ydocGuids) {
				names.add(createOwnedYjsKey(userId, guid));
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
