/**
 * # Vault passphrase keyring
 *
 * Turns a user passphrase into the keyring that drives a value-level encrypted
 * vault (see `createEncryptedYkvLww`). This is the one piece that makes the vault
 * zero-knowledge: the key comes from a passphrase the server never sees, not
 * from a server-issued keyring (ADR 0005). The encrypted-KV primitive is
 * key-source agnostic, so this module is the entire difference between
 * encrypted-at-rest and end-to-end.
 *
 * ## Key flow (ADR 0005)
 *
 * ```txt
 * passphrase + salt ─Argon2id─► KEK ─unwraps─► master key ─► keyring
 * ```
 *
 * - Argon2id is the memory-hard KDF. The salt and parameters are stored as
 *   plaintext vault metadata so any device with the passphrase can re-derive.
 * - The KEK (key-encryption key) only ever wraps and unwraps the master key. It
 *   is never persisted.
 * - The master key is a stable random 32 bytes, generated once and stored
 *   wrapped. It feeds the encrypted KV directly as keyring version 1.
 *
 * The master key is the indirection that earns its keep: a passphrase change
 * rewraps it without re-encrypting a single value, and other devices keep using
 * the master key they already hold (only the wrapping metadata changes, never
 * the encryption key). Deriving the cipher key straight from the passphrase
 * would make every passphrase change a full re-encryption AND a forced re-entry
 * on every other device.
 *
 * There is deliberately NO HKDF step between the master key and the keyring.
 * HKDF scoping (the server path's `deriveWorkspaceKey`) isolates many workspaces
 * sharing one root key; a vault has its own random master key and a single
 * namespace, so there is no sibling to isolate from. ADR 0005's key flow goes
 * master key → keyring directly, and so does this.
 *
 * ## Brute-force surface, stated honestly
 *
 * The salt, parameters, and wrapped master key all ride the relay so a second
 * device can unlock by knowing the passphrase. Anyone holding that metadata can
 * mount an offline brute force; Argon2id raises the per-guess cost but cannot
 * save a guessable passphrase. Passphrase entropy does nearly all the security
 * work, which is why {@link assessPassphraseStrength} and
 * {@link generatePassphrase} live here next to the crypto.
 *
 * @module
 */

import { randomBytes } from '@noble/ciphers/utils.js';
import { argon2id } from '@noble/hashes/argon2.js';
import { type } from 'arktype';
import { decryptBytes, type EncryptedBlob, encryptBytes } from './blob.js';
import { base64ToBytes, bytesToBase64 } from './bytes.js';
import type { WorkspaceKeyring } from './keys.js';

const KEY_LENGTH = 32;
const SALT_LENGTH = 16;

/** The keyring version the master key occupies. Master-key rotation would add higher versions. */
const MASTER_KEY_VERSION = 1;
/** The single KEK version inside the wrapped-master-key blob. A passphrase change overwrites it in place. */
const KEK_VERSION = 1;
/** Binds the wrapped master key to its purpose, so a wrap blob cannot be replayed as a value blob. */
const MASTER_KEY_AAD = new TextEncoder().encode('vault:master-key');

const textEncoder = new TextEncoder();

/**
 * Argon2id cost parameters: passes (`t`), memory in KiB (`m`), and parallelism
 * (`p`). The output length is fixed at 32 bytes, so it is not part of the shape.
 * Stored in vault metadata so a future cost bump can re-derive against the
 * parameters a key was actually created with.
 */
export const Argon2Params = type({
	t: 'number.integer >= 1',
	m: 'number.integer >= 1',
	p: 'number.integer >= 1',
});
export type Argon2Params = typeof Argon2Params.infer;

/**
 * Production Argon2id cost: 3 passes over 64 MiB, single lane. A noticeable but
 * tolerable unlock cost in browser/WASM, and a steep per-guess cost for an
 * offline brute force. Tunable: because the parameters ride the metadata, this
 * can be raised later without stranding existing vaults.
 */
export const PRODUCTION_ARGON2_PARAMS: Argon2Params = {
	t: 3,
	m: 64 * 1024,
	p: 1,
};

/**
 * Plaintext vault metadata. Everything a second device needs to unlock by
 * knowing the passphrase, and nothing the server can decrypt with. It rides the
 * relay alongside the encrypted values; it is the brute-forceable artifact, safe
 * exactly to the entropy of the passphrase that wraps the master key.
 */
export const VaultMetadata = type({
	/** Metadata format version, for forward evolution of this shape. */
	version: '1',
	/** Per-vault Argon2id salt. */
	saltBase64: 'string',
	/** Argon2id cost the KEK was derived with. */
	argon2: Argon2Params,
	/** The master key, encrypted under the passphrase-derived KEK. */
	wrappedMasterKeyBase64: 'string',
});
export type VaultMetadata = typeof VaultMetadata.infer;

/** Derive the key-encryption key from a passphrase and salt. The one expensive step. */
function deriveKek(
	passphrase: string,
	salt: Uint8Array,
	params: Argon2Params,
): Uint8Array {
	return argon2id(textEncoder.encode(passphrase), salt, {
		...params,
		dkLen: KEY_LENGTH,
	});
}

/** Pack a freshly wrapped master key and its salt into serializable metadata. */
function toMetadata(
	salt: Uint8Array,
	params: Argon2Params,
	wrappedMasterKey: EncryptedBlob,
): VaultMetadata {
	return {
		version: 1,
		saltBase64: bytesToBase64(salt),
		argon2: { t: params.t, m: params.m, p: params.p },
		wrappedMasterKeyBase64: bytesToBase64(wrappedMasterKey),
	};
}

/** Wrap a master key under a passphrase: derive the KEK, encrypt, pack metadata. */
function wrapMasterKey(
	passphrase: string,
	masterKey: Uint8Array,
	params: Argon2Params,
): VaultMetadata {
	const salt = randomBytes(SALT_LENGTH);
	const kek = deriveKek(passphrase, salt, params);
	const wrapped = encryptBytes({
		key: kek,
		keyVersion: KEK_VERSION,
		plaintext: masterKey,
		aad: MASTER_KEY_AAD,
	});
	return toMetadata(salt, params, wrapped);
}

/**
 * Set up a brand-new vault. Generates a salt and a stable random master key,
 * wraps the master key under the passphrase, and returns both the metadata to
 * persist (and sync) and the live keyring to hand to
 * `createEncryptedYkvLww(...).activateEncryption()`.
 *
 * The passphrase is taken as-is: this is mechanism, not policy. Gate weak
 * passphrases at the call site with {@link assessPassphraseStrength} before
 * calling, or offer {@link generatePassphrase}.
 *
 * @param params Argon2id cost. Defaults to {@link PRODUCTION_ARGON2_PARAMS};
 *   tests pass cheap parameters to stay fast.
 */
export function createVaultKeyring(
	passphrase: string,
	{ params = PRODUCTION_ARGON2_PARAMS }: { params?: Argon2Params } = {},
): { metadata: VaultMetadata; keyring: WorkspaceKeyring } {
	const masterKey = randomBytes(KEY_LENGTH);
	const metadata = wrapMasterKey(passphrase, masterKey, params);
	return { metadata, keyring: new Map([[MASTER_KEY_VERSION, masterKey]]) };
}

/**
 * Unlock an existing vault: re-derive the KEK from the passphrase and the stored
 * salt, then unwrap the master key. Returns the keyring on success, or `null`
 * when the passphrase is wrong or the metadata is corrupt or tampered. A failed
 * unlock is a normal outcome (someone mistyped), so it is a value, not a throw.
 *
 * Deterministic: the same passphrase and metadata always yield the same master
 * key, which is what lets a second device unlock from the synced metadata alone.
 */
export function unlockVaultKeyring(
	passphrase: string,
	metadata: VaultMetadata,
): WorkspaceKeyring | null {
	const kek = deriveKek(
		passphrase,
		base64ToBytes(metadata.saltBase64),
		metadata.argon2,
	);
	const wrapped = base64ToBytes(
		metadata.wrappedMasterKeyBase64,
	) as EncryptedBlob;
	try {
		const masterKey = decryptBytes({
			keyring: new Map([[KEK_VERSION, kek]]),
			blob: wrapped,
			aad: MASTER_KEY_AAD,
		});
		return new Map([[MASTER_KEY_VERSION, masterKey]]);
	} catch {
		// Wrong KEK fails the Poly1305 tag; a mangled blob fails the format check.
		return null;
	}
}

/**
 * Change the passphrase without re-encrypting any values. Unwraps the master key
 * with the current passphrase, then rewraps the SAME master key under a new
 * passphrase and a fresh salt. Returns the new metadata to persist, or `null`
 * if the current passphrase is wrong.
 *
 * Because the master key (and therefore every value's encryption key) is
 * untouched, the vault's contents do not change and other devices that already
 * hold the master key keep working; only the wrapping metadata they re-read on
 * the next lock is different. This is the whole reason the wrapped-master-key
 * indirection exists.
 */
export function changeVaultPassphrase(
	currentPassphrase: string,
	newPassphrase: string,
	metadata: VaultMetadata,
	{ params = PRODUCTION_ARGON2_PARAMS }: { params?: Argon2Params } = {},
): VaultMetadata | null {
	const keyring = unlockVaultKeyring(currentPassphrase, metadata);
	const masterKey = keyring?.get(MASTER_KEY_VERSION);
	if (!masterKey) return null;
	return wrapMasterKey(newPassphrase, masterKey, params);
}

// ── Passphrase quality ──────────────────────────────────────────────────────
// Passphrase entropy is the dominant security factor, so generating a strong one
// and gating weak ones live next to the keyring crypto rather than in the UI.

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 4648 base32 without padding. 20 bytes (160 bits) encode to exactly 32 symbols. */
function encodeBase32(bytes: Uint8Array): string {
	let bits = 0;
	let value = 0;
	let out = '';
	for (const byte of bytes) {
		value = (value << 8) | byte;
		bits += 8;
		while (bits >= 5) {
			bits -= 5;
			out += BASE32_ALPHABET[(value >>> bits) & 31];
		}
		value &= (1 << bits) - 1;
	}
	if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
	return out;
}

/**
 * Generate a high-entropy passphrase the user stores rather than memorizes (in a
 * password manager). 160 bits of randomness, base32-encoded and grouped for
 * transcription (`XXXXX-XXXXX-...`). Brute force is infeasible against this, so
 * it is the honest answer for a security-conscious user; it flows through the
 * same Argon2id path as a typed passphrase, so nothing downstream is special.
 */
export function generatePassphrase(): string {
	const code = encodeBase32(randomBytes(20));
	return (code.match(/.{1,5}/g) ?? [code]).join('-');
}

/** A passphrase floor: a rough entropy estimate plus whether it clears the bar. */
export type PassphraseStrength = {
	/** Estimated entropy in bits. A naive charset-size estimate; see the caveat below. */
	estimatedBits: number;
	/** Whether the passphrase clears the minimum length and entropy floor. */
	meetsFloor: boolean;
};

const PASSPHRASE_MIN_LENGTH = 12;
const PASSPHRASE_MIN_BITS = 64;

const CHARACTER_CLASSES: ReadonlyArray<{ test: RegExp; poolSize: number }> = [
	{ test: /[a-z]/, poolSize: 26 },
	{ test: /[A-Z]/, poolSize: 26 },
	{ test: /[0-9]/, poolSize: 10 },
	{ test: /[^a-zA-Z0-9]/, poolSize: 33 },
];

/**
 * Estimate passphrase strength against a fixed floor.
 *
 * The estimate is `length × log2(poolSize)`, where the pool is the union of the
 * character classes present. This is deliberately simple, and it OVERestimates:
 * it cannot see that `Password123!` is a common pattern, only that it mixes
 * classes. It is a backstop for typed passphrases, not a substitute for
 * {@link generatePassphrase}, which is the recommended path precisely because
 * this kind of estimate is unreliable for human-chosen secrets.
 */
export function assessPassphraseStrength(
	passphrase: string,
): PassphraseStrength {
	const poolSize = CHARACTER_CLASSES.reduce(
		(sum, { test, poolSize }) => sum + (test.test(passphrase) ? poolSize : 0),
		0,
	);
	const estimatedBits =
		poolSize > 0 ? Math.round(passphrase.length * Math.log2(poolSize)) : 0;
	const meetsFloor =
		passphrase.length >= PASSPHRASE_MIN_LENGTH &&
		estimatedBits >= PASSPHRASE_MIN_BITS;
	return { estimatedBits, meetsFloor };
}
