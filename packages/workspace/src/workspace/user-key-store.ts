import type { Brand } from 'wellcrafted/brand';

/**
 * Branded string representing `JSON.stringify(EncryptionKeys)`.
 *
 * Prevents accidentally passing an arbitrary string to `UserKeyStore.set()`
 * or treating a raw `UserKeyStore.get()` result as plain text. The only
 * way to produce this type is through the branded cast in `create-workspace.ts`
 * after `JSON.stringify(keys)` — store implementations treat it as an opaque string.
 */
export type EncryptionKeysJson = string & Brand<'EncryptionKeysJson'>;

/**
 * Platform-agnostic interface for persisting encryption keys across sessions.
 *
 * Stores the encryption keys as a JSON string—`JSON.stringify(EncryptionKey[])`
 * where each entry is `{ version: number, userKeyBase64: string }`. The store
 * interface deals only in opaque strings; callers handle serialization.
 *
 * Passing a `UserKeyStore` to `.withEncryption({ userKeyStore })` implies
 * auto-boot: the workspace loads the cached keys on startup and unlocks
 * immediately if available. No explicit boot call is needed.
 *
 * | Platform         | Implementation                                            |
 * |------------------|-----------------------------------------------------------|
 * | Tauri desktop    | `tauri-plugin-stronghold` — encrypted vault, memory zeroization |
 * | Browser          | `sessionStorage` — survives refresh, clears on tab close  |
 * | Chrome extension | WXT storage (`session:` area over `chrome.storage.session`) — survives popup/sidebar reopens |
 * | Self-hosted      | No cache — user enters password each session              |
 *
 * ## How It Fits
 *
 * ```
 * Server (auth session)
 *   │  encryptionKeys: [{ version, userKeyBase64 }, ...]
 *   ▼
 * UserKeyStore.set(JSON.stringify(encryptionKeys))
 *   │  stored locally as opaque string
 *   ▼
 * App startup (before auth roundtrip completes)
 *   │  UserKeyStore.get() → JSON string | null
 *   │  consumed by auto-boot in whenReady
 *   ▼
 * auto-boot → JSON.parse → unlock(keys) → deriveWorkspaceKey per version
 *   │  base64 decoding + HKDF happens inside unlock()
 * ```
 *
 * Without a `UserKeyStore`, every page refresh requires a full auth roundtrip
 * before encrypted data can be read. With a store, the workspace unlocks
 * immediately on launch using the cached keys, then refreshes them silently when
 * the session loads.
 */
export type UserKeyStore = {
	/**
	 * Persist the latest encryption keys as a JSON string.
	 *
	 * Called after the workspace receives or refreshes valid keys from the
	 * auth session. Implementations store one value and overwrite any
	 * older cached entry.
	 */
	set(keysJson: EncryptionKeysJson): Promise<void>;
	/**
	 * Retrieve the cached encryption keys during startup.
	 *
	 * Called automatically during `whenReady` when a `UserKeyStore` is provided
	 * to `.withEncryption()`. Return `null` to skip auto-unlock and wait for
	 * the server session to provide keys.
	 */
	get(): Promise<EncryptionKeysJson | null>;
	/**
	 * Remove the cached key on sign-out or account switch.
	 *
	 * This should clear only the encryption-key entry owned by the cache, not
	 * unrelated storage used by the host app.
	 */
	delete(): Promise<void>;
};
