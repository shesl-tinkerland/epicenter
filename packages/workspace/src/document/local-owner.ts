/// <reference lib="dom" />

/**
 * createLocalOwner: identity-scoped facade for authenticated browser
 * workspaces.
 *
 * One owner per signed-in subject. Every browser-local Yjs artifact
 * (IndexedDB database name, BroadcastChannel key, wipe namespace) is keyed by
 * `(subject, ydocGuid)`, and every encrypted resource is bound to the same
 * subject's keyring. The owner is the one named place that knows the pair.
 *
 * Daemons do not construct an owner: they call `attachEncryption` directly
 * with just `keyring` and persist via filesystem instead of IDB.
 *
 * The durable IndexedDB database prefix remains `epicenter.v1.user.` so
 * existing encrypted data is still readable. Public API renames from
 * `userId` to `subject`; the storage label stays stable for v1 data.
 */

import type { SubjectKeyring } from '@epicenter/encryption';
import { clearDocument } from 'y-indexeddb';
import type * as Y from 'yjs';
import { attachBroadcastChannelWithKey } from './attach-broadcast-channel.js';
import { attachEncryptedIndexedDb } from './attach-encrypted-indexed-db.js';
import { attachEncryption } from './attach-encryption.js';
import { createOwnedYjsKey } from './local-yjs-key.js';

export type LocalOwner = ReturnType<typeof createLocalOwner>;

export function createLocalOwner({
	subject,
	keyring,
}: {
	subject: string;
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
		 * `createOwnedYjsKey(subject, ydoc.guid)` so other signed-in subjects
		 * on the same browser profile cannot read this subject's persisted
		 * CRDT state.
		 */
		attachIndexedDb(ydoc: Y.Doc) {
			return attachEncryptedIndexedDb(ydoc, {
				databaseName: createOwnedYjsKey(subject, ydoc.guid),
				keyring,
			});
		},
		/**
		 * Attach owner-scoped cross-tab BroadcastChannel sync. Two signed-in
		 * subjects in the same browser profile cannot exchange plaintext
		 * updates through BroadcastChannel.
		 */
		attachBroadcastChannel(ydoc: Y.Doc) {
			attachBroadcastChannelWithKey(ydoc, createOwnedYjsKey(subject, ydoc.guid));
		},
		/**
		 * Delete every owner-scoped IndexedDB database currently visible to
		 * this browser profile, plus any explicitly named ones. Use from
		 * `wipe()` paths on sign-out so the next signed-in subject starts
		 * from a clean slate.
		 *
		 * The prefix is intentionally `epicenter.v1.user.{subject}.yjs.` so
		 * v1 data written by older builds remains accessible.
		 */
		async wipeLocalYjsData(ydocGuids: Iterable<string> = []) {
			const prefix = `epicenter.v1.user.${subject}.yjs.`;
			const names = new Set<string>();

			for (const guid of ydocGuids) {
				names.add(createOwnedYjsKey(subject, guid));
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
