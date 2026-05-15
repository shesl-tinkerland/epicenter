/**
 * Encode bytes for JSON transport and storage surfaces that require strings.
 *
 * Use this for key material that must cross an auth-session boundary. Encrypted
 * blobs should stay as `Uint8Array` values instead of being base64 encoded.
 */
export function bytesToBase64(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}

/**
 * Decode base64 key material back into bytes.
 *
 * Pair this with `bytesToBase64()` when consuming
 * `SubjectKeyringEntry.subjectKeyBase64` from an auth session.
 */
export function base64ToBytes(base64: string): Uint8Array {
	const binaryString = atob(base64);
	const bytes = new Uint8Array(binaryString.length);
	for (let i = 0; i < binaryString.length; i++) {
		bytes[i] = binaryString.charCodeAt(i);
	}
	return bytes;
}
