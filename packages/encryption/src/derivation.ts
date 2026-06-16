import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToBase64 } from './bytes.js';
import type { Keyring } from './keys.js';
import type { RootKeyring } from './secrets.js';

const textEncoder = new TextEncoder();

/**
 * Derive a per-workspace key from a label key.
 *
 * Workspace encryption never uses the label key directly. It derives a
 * workspace-scoped key with HKDF and `workspace:{workspaceId}` as the info
 * label, so the same label key produces independent keys for different
 * workspaces.
 *
 * @example
 * ```typescript
 * const keyBytes = base64ToBytes(session.keyring[0].keyBytesBase64);
 * const workspaceKey = deriveWorkspaceKey(keyBytes, workspaceId);
 * ```
 */
export function deriveWorkspaceKey(
	keyBytes: Uint8Array,
	workspaceId: string,
): Uint8Array {
	return hkdf(
		sha256,
		keyBytes,
		new Uint8Array(0),
		textEncoder.encode(`workspace:${workspaceId}`),
		32,
	);
}

async function deriveLabelKey(
	secret: string,
	label: string,
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
			info: textEncoder.encode(`owner:${label}`),
		},
		hkdfKey,
		256,
	);
	return new Uint8Array(derivedBits);
}

/**
 * Derive a per-label keyring from a root keyring.
 *
 * The API uses this after resolving its root keyring. It returns one
 * `{ version, keyBytesBase64 }` entry per root version, preserving the
 * keyring order supplied by `parseRootKeyring()`.
 *
 * The `label` argument is the caller's partition string (typically an
 * `OwnerId`). The HKDF info bytes are `owner:${label}`, matching the
 * public vocabulary; there is no separate legacy prefix to support.
 *
 * @example
 * ```typescript
 * const rootKeyring = parseRootKeyring(env.ENCRYPTION_SECRETS);
 * const keyring = await deriveKeyring({
 *   rootKeyring,
 *   label: ownerId,
 * });
 * ```
 */
export async function deriveKeyring({
	rootKeyring,
	label,
}: {
	rootKeyring: RootKeyring;
	label: string;
}): Promise<Keyring> {
	return Promise.all(
		rootKeyring.map(async ({ version, secret }) => ({
			version,
			keyBytesBase64: bytesToBase64(await deriveLabelKey(secret, label)),
		})),
	) as Promise<Keyring>;
}
