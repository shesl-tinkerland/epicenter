import { randomBytes } from '@noble/ciphers/utils.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { pbkdf2 } from '@noble/hashes/pbkdf2.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToBase64 } from './bytes.js';
import { assertEncryptionKeyVersion, type SubjectKeyring } from './keys.js';
import type { RootKeyring } from './secrets.js';

const textEncoder = new TextEncoder();
const SALT_LENGTH = 32;
const PBKDF2_ITERATIONS_DEFAULT = 600_000;

/**
 * Derive a per-workspace key from a per-subject key.
 *
 * Workspace encryption never uses the subject key directly. It derives a
 * workspace-scoped key with HKDF and `workspace:{workspaceId}` as the info
 * label, so the same subject key produces independent keys for different
 * workspaces.
 *
 * @example
 * ```typescript
 * const subjectKey = base64ToBytes(session.localIdentity.keyring[0].subjectKeyBase64);
 * const workspaceKey = deriveWorkspaceKey(subjectKey, workspaceId);
 * ```
 */
export function deriveWorkspaceKey(
	subjectKey: Uint8Array,
	workspaceId: string,
): Uint8Array {
	return hkdf(
		sha256,
		subjectKey,
		new Uint8Array(0),
		textEncoder.encode(`workspace:${workspaceId}`),
		32,
	);
}

/**
 * Derive a 32-byte subject key from a password and salt.
 *
 * This helper is for self-managed or local password flows. Cloud API sessions
 * should use `deriveSubjectKeyring()` with a root keyring instead.
 */
export function deriveKeyFromPassword(
	password: string,
	salt: Uint8Array,
	iterations: number = PBKDF2_ITERATIONS_DEFAULT,
): Uint8Array {
	return pbkdf2(sha256, textEncoder.encode(password), salt, {
		c: iterations,
		dkLen: 32,
	});
}

/**
 * Generate a PBKDF2 salt for password-derived subject keys.
 *
 * This salt is not an encryption nonce. Store it next to the password-derived
 * key metadata so the same password can derive the same subject key later.
 */
export function generateSalt(): Uint8Array {
	return randomBytes(SALT_LENGTH);
}

/**
 * Wrap raw subject key bytes in the auth-session keyring shape.
 *
 * Use this when a caller already has subject key material, such as a
 * password-derived key. Server-side root keyring derivation should call
 * `deriveSubjectKeyring()` so every configured root version is included.
 */
export function buildSubjectKeyring(
	subjectKey: Uint8Array,
	version: number = 1,
): SubjectKeyring {
	assertEncryptionKeyVersion(version);
	return [{ version, subjectKeyBase64: bytesToBase64(subjectKey) }];
}

async function deriveSubjectKey(
	secret: string,
	subject: string,
): Promise<Uint8Array> {
	const rawKey = await crypto.subtle.digest(
		'SHA-256',
		textEncoder.encode(secret),
	);
	const hkdfKey = await crypto.subtle.importKey('raw', rawKey, 'HKDF', false, [
		'deriveBits',
	]);
	const derivedBits = await crypto.subtle.deriveBits(
		{
			name: 'HKDF',
			hash: 'SHA-256',
			salt: new Uint8Array(0),
			info: textEncoder.encode(`subject:${subject}`),
		},
		hkdfKey,
		256,
	);
	return new Uint8Array(derivedBits);
}

/**
 * Derive a per-subject keyring from a root keyring.
 *
 * The API uses this after resolving its root keyring. It returns one
 * `{ version, subjectKeyBase64 }` entry per root version, preserving the
 * keyring order supplied by `parseRootKeyring()`.
 *
 * @example
 * ```typescript
 * const rootKeyring = parseRootKeyring(env.ENCRYPTION_SECRETS);
 * const keyring = await deriveSubjectKeyring({
 *   rootKeyring,
 *   subject: user.id,
 * });
 * ```
 */
export async function deriveSubjectKeyring({
	rootKeyring,
	subject,
}: {
	rootKeyring: RootKeyring;
	subject: string;
}): Promise<SubjectKeyring> {
	return Promise.all(
		rootKeyring.map(async ({ version, secret }) => ({
			version,
			subjectKeyBase64: bytesToBase64(await deriveSubjectKey(secret, subject)),
		})),
	) as Promise<SubjectKeyring>;
}

export { PBKDF2_ITERATIONS_DEFAULT };
