import { describe, expect, test } from 'bun:test';
import {
	type Argon2Params,
	assessPassphraseStrength,
	changeVaultPassphrase,
	createVaultKeyring,
	generatePassphrase,
	unlockVaultKeyring,
} from './passphrase.js';

/** Cheap Argon2id cost so the suite stays fast. Production uses far steeper parameters. */
const TEST_PARAMS: Argon2Params = { t: 1, m: 8 * 1024, p: 1 };

const MASTER_KEY_VERSION = 1;

/** The 32-byte master key the keyring exposes at version 1. */
function masterKeyOf(keyring: ReadonlyMap<number, Uint8Array>): Uint8Array {
	const key = keyring.get(MASTER_KEY_VERSION);
	if (!key) throw new Error('keyring has no master key');
	return key;
}

describe('createVaultKeyring / unlockVaultKeyring', () => {
	test('a second device unlocks from the passphrase and synced metadata alone', () => {
		const passphrase = 'correct horse battery staple';
		const { metadata, keyring } = createVaultKeyring(passphrase, {
			params: TEST_PARAMS,
		});

		// Only the metadata crosses to the other device; the keyring does not.
		const unlocked = unlockVaultKeyring(passphrase, metadata);

		expect(unlocked).not.toBeNull();
		expect(masterKeyOf(unlocked!)).toEqual(masterKeyOf(keyring));
	});

	test('unlock is deterministic across repeated calls', () => {
		const { metadata } = createVaultKeyring('a passphrase to remember', {
			params: TEST_PARAMS,
		});

		const first = unlockVaultKeyring('a passphrase to remember', metadata);
		const second = unlockVaultKeyring('a passphrase to remember', metadata);

		expect(first).not.toBeNull();
		expect(masterKeyOf(first!)).toEqual(masterKeyOf(second!));
	});

	test('the master key is a 32-byte secret, not the passphrase', () => {
		const { keyring } = createVaultKeyring('a passphrase to remember', {
			params: TEST_PARAMS,
		});

		expect(masterKeyOf(keyring)).toBeInstanceOf(Uint8Array);
		expect(masterKeyOf(keyring).length).toBe(32);
	});

	test('a fresh vault gets a fresh salt and master key each time', () => {
		const first = createVaultKeyring('same passphrase here', {
			params: TEST_PARAMS,
		});
		const second = createVaultKeyring('same passphrase here', {
			params: TEST_PARAMS,
		});

		expect(first.metadata.saltBase64).not.toBe(second.metadata.saltBase64);
		expect(masterKeyOf(first.keyring)).not.toEqual(masterKeyOf(second.keyring));
	});

	test('metadata records the parameters the key was created with', () => {
		const { metadata } = createVaultKeyring('a passphrase to remember', {
			params: TEST_PARAMS,
		});

		expect(metadata.argon2).toEqual(TEST_PARAMS);
		expect(metadata.version).toBe(1);
	});
});

describe('wrong passphrase and tampering', () => {
	test('the wrong passphrase cannot unlock', () => {
		const { metadata } = createVaultKeyring('the real passphrase', {
			params: TEST_PARAMS,
		});

		expect(unlockVaultKeyring('not the passphrase', metadata)).toBeNull();
	});

	test('a tampered wrapped master key fails to unlock', () => {
		const passphrase = 'the real passphrase';
		const { metadata } = createVaultKeyring(passphrase, {
			params: TEST_PARAMS,
		});

		// Flip a byte inside the wrapped master key; the Poly1305 tag must reject it.
		const wrapped = Buffer.from(metadata.wrappedMasterKeyBase64, 'base64');
		const last = wrapped.length - 1;
		wrapped[last] = (wrapped[last] ?? 0) ^ 0xff;
		const tampered = {
			...metadata,
			wrappedMasterKeyBase64: wrapped.toString('base64'),
		};

		expect(unlockVaultKeyring(passphrase, tampered)).toBeNull();
	});
});

describe('changeVaultPassphrase', () => {
	test('keeps the same master key so values never need re-encryption', () => {
		const { metadata, keyring } = createVaultKeyring('first passphrase', {
			params: TEST_PARAMS,
		});

		const rewrapped = changeVaultPassphrase(
			'first passphrase',
			'second passphrase',
			metadata,
			{ params: TEST_PARAMS },
		);
		expect(rewrapped).not.toBeNull();

		const unlocked = unlockVaultKeyring('second passphrase', rewrapped!);
		expect(unlocked).not.toBeNull();
		// The encryption key is unchanged; only the wrapping moved.
		expect(masterKeyOf(unlocked!)).toEqual(masterKeyOf(keyring));
	});

	test('the old passphrase no longer unlocks the rewrapped metadata', () => {
		const { metadata } = createVaultKeyring('first passphrase', {
			params: TEST_PARAMS,
		});

		const rewrapped = changeVaultPassphrase(
			'first passphrase',
			'second passphrase',
			metadata,
			{ params: TEST_PARAMS },
		);

		expect(unlockVaultKeyring('first passphrase', rewrapped!)).toBeNull();
	});

	test('returns null when the current passphrase is wrong', () => {
		const { metadata } = createVaultKeyring('first passphrase', {
			params: TEST_PARAMS,
		});

		expect(
			changeVaultPassphrase('wrong current', 'second passphrase', metadata, {
				params: TEST_PARAMS,
			}),
		).toBeNull();
	});
});

describe('generatePassphrase', () => {
	test('produces a grouped high-entropy code that clears the floor', () => {
		const generated = generatePassphrase();

		expect(generated).toMatch(/^[A-Z2-7]{5}(-[A-Z2-7]{1,5})+$/);
		expect(assessPassphraseStrength(generated).meetsFloor).toBe(true);
	});

	test('is different every time', () => {
		expect(generatePassphrase()).not.toBe(generatePassphrase());
	});
});

describe('assessPassphraseStrength', () => {
	test('rejects a short single-class passphrase', () => {
		const weak = assessPassphraseStrength('password');
		expect(weak.meetsFloor).toBe(false);
	});

	test('accepts a long mixed-class passphrase', () => {
		const strong = assessPassphraseStrength('Tr0ub4dour-&-3xtra-l0ng');
		expect(strong.meetsFloor).toBe(true);
		expect(strong.estimatedBits).toBeGreaterThanOrEqual(64);
	});

	test('reports zero bits for the empty string', () => {
		expect(assessPassphraseStrength('')).toEqual({
			estimatedBits: 0,
			meetsFloor: false,
		});
	});
});
