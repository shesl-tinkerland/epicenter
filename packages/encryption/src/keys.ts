import { type } from 'arktype';

/**
 * Transport-safe per-subject key material delivered through auth sessions.
 *
 * The version is capped at 255 because encrypted blobs store the key version
 * in a single byte. `subjectKeyBase64` is actual key material, not a fingerprint
 * or public identifier, so callers should treat values matching this schema as
 * secrets.
 */
export const SubjectKeyringEntry = type({
	version: '1 <= number.integer <= 255',
	subjectKeyBase64: 'string',
});

/**
 * Non-empty keyring of per-subject keys.
 *
 * New writes use the highest version after workspace activation. Older entries
 * stay in the keyring so activation can decrypt old-version blobs and rewrite
 * them under the current version.
 */
export const SubjectKeyring = type([
	SubjectKeyringEntry,
	'...',
	SubjectKeyringEntry.array(),
]);

export type SubjectKeyringEntry = typeof SubjectKeyringEntry.infer;
export type SubjectKeyring = typeof SubjectKeyring.infer;

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
 * Compare two subject keyrings without creating a secret-bearing string.
 *
 * This is intentionally structural and order-independent. Use it for cache or
 * state dedup checks where the old `fingerprint` helper was tempting, but do
 * not log either input because both contain live key material.
 *
 * @example
 * ```typescript
 * if (!subjectKeyringsEqual(nextKeyring, currentKeyring)) {
 *   currentKeyring = nextKeyring;
 * }
 * ```
 */
export function subjectKeyringsEqual(
	left: SubjectKeyring,
	right: SubjectKeyring,
): boolean {
	if (left.length !== right.length) return false;
	const sortedLeft = [...left].sort((a, b) => a.version - b.version);
	const sortedRight = [...right].sort((a, b) => a.version - b.version);
	return sortedLeft.every((leftKey, index) => {
		const rightKey = sortedRight[index];
		return (
			rightKey !== undefined &&
			leftKey.version === rightKey.version &&
			leftKey.subjectKeyBase64 === rightKey.subjectKeyBase64
		);
	});
}
