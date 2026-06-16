import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { randomBytes } from '@noble/ciphers/utils.js';
import type { Brand } from 'wellcrafted/brand';
import {
	assertEncryptionKeyVersion,
	type ReadonlyWorkspaceKeyring,
} from './keys.js';

const NONCE_LENGTH = 24;
const TAG_LENGTH = 16;
const HEADER_LENGTH = 2;
const MINIMUM_BLOB_SIZE = HEADER_LENGTH + NONCE_LENGTH + TAG_LENGTH;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/**
 * Binary encrypted value stored directly in Yjs.
 *
 * The format is fixed-width header plus variable ciphertext:
 * byte 0 is format version `1`, byte 1 is key version, bytes 2 through 25 are
 * the XChaCha20 nonce, and the remaining bytes are ciphertext plus tag.
 */
export type EncryptedBlob = Uint8Array & Brand<'EncryptedBlob'>;

export type EncryptBytesOptions = {
	key: Uint8Array;
	keyVersion: number;
	plaintext: Uint8Array;
	aad?: Uint8Array;
};

export type DecryptBytesOptions = {
	keyring: ReadonlyWorkspaceKeyring;
	blob: EncryptedBlob;
	aad?: Uint8Array;
};

function decryptCiphertextBytes(
	blob: EncryptedBlob,
	key: Uint8Array,
	aad?: Uint8Array,
): Uint8Array {
	if (key.length !== 32) throw new Error('Encryption key must be 32 bytes');
	const formatVersion = blob[0];
	if (formatVersion !== 1) {
		throw new Error(
			`Unknown encryption format version: ${formatVersion}. This blob may require a newer client.`,
		);
	}

	const nonce = blob.slice(HEADER_LENGTH, HEADER_LENGTH + NONCE_LENGTH);
	const ciphertext = blob.slice(HEADER_LENGTH + NONCE_LENGTH);
	const cipher = aad
		? xchacha20poly1305(key, nonce, aad)
		: xchacha20poly1305(key, nonce);
	return cipher.decrypt(ciphertext);
}

/**
 * Encrypt arbitrary bytes into the current binary blob format.
 *
 * This is the storage-level sibling to `encryptValue`: callers that already
 * have bytes, such as Yjs update payloads, should use this instead of
 * round-tripping through strings.
 */
export function encryptBytes({
	key,
	keyVersion,
	plaintext,
	aad,
}: EncryptBytesOptions): EncryptedBlob {
	if (key.length !== 32) throw new Error('Encryption key must be 32 bytes');
	assertEncryptionKeyVersion(keyVersion);
	const nonce = randomBytes(NONCE_LENGTH);
	const cipher = aad
		? xchacha20poly1305(key, nonce, aad)
		: xchacha20poly1305(key, nonce);
	const ciphertext = cipher.encrypt(plaintext);

	const packed = new Uint8Array(
		HEADER_LENGTH + nonce.length + ciphertext.length,
	);
	packed[0] = 1;
	packed[1] = keyVersion;
	packed.set(nonce, HEADER_LENGTH);
	packed.set(ciphertext, HEADER_LENGTH + nonce.length);

	return packed as EncryptedBlob;
}

/**
 * Decrypt arbitrary bytes from the current binary blob format.
 *
 * The key is selected from `keyring` by the key-version byte stored in the
 * blob header. Keep old keys in the map while old local blobs remain readable.
 */
export function decryptBytes({
	keyring,
	blob,
	aad,
}: DecryptBytesOptions): Uint8Array {
	const keyVersion = getKeyVersion(blob);
	const key = keyring.get(keyVersion);
	if (key === undefined) {
		throw new Error(
			`Cannot decrypt encrypted blob: key version ${keyVersion} is not in the keyring.`,
		);
	}
	return decryptCiphertextBytes(blob, key, aad);
}

/**
 * Encrypt a plaintext string into the current binary blob format.
 *
 * The key must already be scoped to the storage context, for example via
 * `deriveWorkspaceKey()`. `aad` binds the ciphertext to caller-owned context
 * such as an entry key, preventing a valid blob from being moved to a different
 * logical slot without detection.
 *
 * @example
 * ```typescript
 * const aad = new TextEncoder().encode(entryKey);
 * const blob = encryptValue(JSON.stringify(value), workspaceKey, aad, 2);
 * ```
 */
export function encryptValue(
	plaintext: string,
	key: Uint8Array,
	aad?: Uint8Array,
	keyVersion: number = 1,
): EncryptedBlob {
	return encryptBytes({
		key,
		keyVersion,
		plaintext: textEncoder.encode(plaintext),
		aad,
	});
}

/**
 * Decrypt an `EncryptedBlob` with the selected key.
 *
 * This function validates the blob format byte, but it does not choose a key
 * from a keyring. Call `getKeyVersion()` first when decrypting rotated data so
 * the caller can select the key matching byte 1.
 */
export function decryptValue(
	blob: EncryptedBlob,
	key: Uint8Array,
	aad?: Uint8Array,
): string {
	return textDecoder.decode(decryptCiphertextBytes(blob, key, aad));
}

/**
 * Read the key version from blob byte 1 without decrypting.
 *
 * Workspace storage uses this to select the right key from a rotated keyring
 * before calling `decryptValue()`.
 */
export function getKeyVersion(blob: EncryptedBlob): number {
	return blob[1] as number;
}

/**
 * Detect values written by the current encrypted blob format.
 *
 * User values are plain JSON-shaped data, not byte arrays, so this guard is the
 * boundary between plaintext values and encrypted storage values inside the Yjs
 * wrapper.
 */
export function isEncryptedBlob(value: unknown): value is EncryptedBlob {
	return (
		value instanceof Uint8Array &&
		value.length >= MINIMUM_BLOB_SIZE &&
		value[0] === 1
	);
}
