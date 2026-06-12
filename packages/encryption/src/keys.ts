import { type } from 'arktype';

/**
 * Transport-safe per-label key material delivered through auth sessions.
 *
 * The version is capped at 255 because encrypted blobs store the key version
 * in a single byte. `keyBytesBase64` is actual key material, not a fingerprint
 * or public identifier, so callers should treat values matching this schema as
 * secrets.
 */
export const KeyringEntry = type({
	version: '1 <= number.integer <= 255',
	keyBytesBase64: 'string',
});

/**
 * Non-empty keyring.
 *
 * New writes use the highest version after workspace activation. Older entries
 * stay in the keyring so activation can decrypt old-version blobs and rewrite
 * them under the current version, and so locally persisted update logs written
 * before a rotation stay readable on the next attach. Dropping a version
 * orphans every blob still encrypted under it.
 */
export const Keyring = type([KeyringEntry, '...', KeyringEntry.array()]);

export type KeyringEntry = typeof KeyringEntry.infer;
export type Keyring = typeof Keyring.infer;

/**
 * Per-workspace HKDF keyring derived locally from a `Keyring`.
 *
 * Each entry maps a key version to the raw 32-byte workspace key derived via
 * `deriveWorkspaceKey(keyBytes, workspaceId)`. The map is rebuilt once per
 * `createWorkspace({ keyring })` call so workspace key bytes do not outlive
 * the Y.Doc.
 *
 * The version axis equals the version axis of the source `Keyring`: one
 * workspace key per keyring entry, never persisted.
 */
export type WorkspaceKeyring = Map<number, Uint8Array>;

/**
 * Readonly view of a `WorkspaceKeyring`. Encrypt/decrypt boundaries take this
 * shape so the cipher cannot mutate the caller's derived keyring.
 */
export type ReadonlyWorkspaceKeyring = ReadonlyMap<number, Uint8Array>;

/**
 * Reject versions that cannot be represented in the encrypted blob header.
 *
 * Blob byte 1 stores the key version. Validating this at public entry points
 * prevents silent truncation before a value reaches storage.
 */
export function assertEncryptionKeyVersion(version: number): void {
	if (!Number.isInteger(version) || version < 1 || version > 255) {
		throw new Error('Encryption key version must be an integer from 1 to 255');
	}
}

/**
 * Compare two keyrings without creating a secret-bearing string.
 *
 * This is intentionally structural and order-independent. Use it for cache or
 * state dedup checks where the old `fingerprint` helper was tempting, but do
 * not log either input because both contain live key material.
 *
 * @example
 * ```typescript
 * if (!keyringsEqual(nextKeyring, currentKeyring)) {
 *   currentKeyring = nextKeyring;
 * }
 * ```
 */
export function keyringsEqual(left: Keyring, right: Keyring): boolean {
	if (left.length !== right.length) return false;
	const sortedLeft = [...left].sort((a, b) => a.version - b.version);
	const sortedRight = [...right].sort((a, b) => a.version - b.version);
	return sortedLeft.every((leftKey, index) => {
		const rightKey = sortedRight[index];
		return (
			rightKey !== undefined &&
			leftKey.version === rightKey.version &&
			leftKey.keyBytesBase64 === rightKey.keyBytesBase64
		);
	});
}
