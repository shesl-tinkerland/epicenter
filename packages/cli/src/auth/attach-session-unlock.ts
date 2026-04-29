/**
 * `attachSessionUnlock`: apply the stored CLI session's encryption keys to
 * an `EncryptionAttachment`.
 *
 * Follows the attach-primitive convention: subject first, synchronous return,
 * promise-valued barrier (`whenChecked`). Resolves even in anonymous mode
 * (no stored session, no keys to apply); it's a "setup complete" barrier,
 * not a "keys were applied" assertion.
 *
 * @example
 * ```ts
 * const encryption = attachEncryption(ydoc);
 * const persistence = attachSqlite(ydoc, { filePath });
 * const unlock = attachSessionUnlock(encryption, {
 *   sessions,
 *   serverUrl: SERVER_URL,
 *   waitFor: persistence.whenLoaded,
 * });
 * const sync = attachSync(ydoc, {
 *   url,
 *   getToken,
 *   waitFor: Promise.all([persistence.whenLoaded, unlock.whenChecked]),
 * });
 * ```
 */

import type { EncryptionAttachment } from '@epicenter/workspace';
import type { SessionStore } from './session-store.js';

export type SessionUnlockAttachment = {
	/**
	 * Resolves after the stored session has been checked and any encryption
	 * keys present on it have been applied to the `EncryptionAttachment`.
	 * Resolves even in anonymous mode (no stored session, no keys to apply);
	 * it's a "setup complete" barrier, not a "keys were applied" assertion.
	 */
	whenChecked: Promise<unknown>;
};

/**
 * Apply the stored CLI session's encryption keys to an `EncryptionAttachment`.
 *
 * @param encryption - The `EncryptionAttachment` whose keys should be applied.
 * @param opts.sessions  - The CLI session store to load the session from.
 * @param opts.serverUrl - The server URL the session is keyed by.
 * @param opts.waitFor   - Optional upstream gate, typically `persistence.whenLoaded`,
 *                         so stored keys aren't applied before hydration completes.
 */
export function attachSessionUnlock(
	encryption: EncryptionAttachment,
	{
		sessions,
		serverUrl,
		waitFor,
	}: {
		sessions: SessionStore;
		serverUrl: string;
		/** Optional upstream gate, typically `persistence.whenLoaded`. */
		waitFor?: Promise<unknown>;
	},
): SessionUnlockAttachment {
	const whenChecked = (async () => {
		if (waitFor) await waitFor;
		const session = await sessions.load(serverUrl);
		if (session?.encryptionKeys) {
			encryption.applyKeys(session.encryptionKeys);
		}
	})();
	return { whenChecked };
}
