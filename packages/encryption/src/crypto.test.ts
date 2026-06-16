/**
 * Encryption Primitive Tests
 *
 * Verifies the generic crypto helpers that protect encrypted storage and key
 * derivation. These tests pin the blob format, key derivation, keyring codec,
 * and key equality contracts owned by this package.
 *
 * Key behaviors:
 * - XChaCha20-Poly1305 round trips plaintext and rejects tampering
 * - Key versions stay inside the one-byte encrypted blob range
 * - Keyring parsing canonicalizes order and rejects ambiguous inputs
 * - Derivation helpers stay deterministic and Web Crypto compatible
 */

import { describe, expect, test } from 'bun:test';
import { randomBytes } from '@noble/ciphers/utils.js';
import {
	base64ToBytes,
	bytesToBase64,
	decryptBytes,
	decryptValue,
	deriveKeyring,
	deriveWorkspaceKey,
	type EncryptedBlob,
	encryptBytes,
	encryptValue,
	getKeyVersion,
	isEncryptedBlob,
	keyringsEqual,
	parseRootKeyring,
} from './index.js';

async function deriveWorkspaceKeyWithWebCrypto(
	keyBytes: Uint8Array,
	workspaceId: string,
): Promise<Uint8Array> {
	const hkdfKey = await crypto.subtle.importKey(
		'raw',
		new Uint8Array(keyBytes).buffer,
		'HKDF',
		false,
		['deriveBits'],
	);
	const derivedBits = await crypto.subtle.deriveBits(
		{
			name: 'HKDF',
			hash: 'SHA-256',
			salt: new Uint8Array(0),
			info: new TextEncoder().encode(`workspace:${workspaceId}`),
		},
		hkdfKey,
		256,
	);
	return new Uint8Array(derivedBits);
}

describe('encryptValue and decryptValue', () => {
	test('encrypt then decrypt returns original string', () => {
		const key = randomBytes(32);
		const plaintext = JSON.stringify({ id: '123', active: true });
		const encrypted = encryptValue(plaintext, key);

		expect(decryptValue(encrypted, key)).toBe(plaintext);
		expect(encrypted).toBeInstanceOf(Uint8Array);
		expect(encrypted[0]).toBe(1);
		expect(encrypted[1]).toBe(1);
		expect(encrypted.length).toBeGreaterThanOrEqual(42);
	});

	test('each encryption uses a fresh nonce', () => {
		const key = randomBytes(32);
		const plaintext = 'same plaintext';
		const encrypted1 = encryptValue(plaintext, key);
		const encrypted2 = encryptValue(plaintext, key);

		expect(encrypted1).not.toEqual(encrypted2);
		expect(decryptValue(encrypted1, key)).toBe(plaintext);
		expect(decryptValue(encrypted2, key)).toBe(plaintext);
	});

	test('custom key version is embedded at byte 1', () => {
		const key = randomBytes(32);
		const encrypted = encryptValue('test', key, undefined, 7);

		expect(encrypted[1]).toBe(7);
		expect(getKeyVersion(encrypted)).toBe(7);
	});

	test('key versions outside 1 to 255 throw before writing blob header', () => {
		const key = randomBytes(32);

		expect(() => encryptValue('test', key, undefined, 0)).toThrow();
		expect(() => encryptValue('test', key, undefined, 256)).toThrow();
	});

	test('invalid key size throws', () => {
		expect(() => encryptValue('test', new Uint8Array(16))).toThrow();
	});

	test('tampered ciphertext throws', () => {
		const key = randomBytes(32);
		const encrypted = encryptValue('test', key);
		const tampered = new Uint8Array(encrypted);
		tampered[26] = (tampered[26] as number) ^ 0xff;

		expect(() => decryptValue(tampered as EncryptedBlob, key)).toThrow();
	});

	test('mismatched AAD throws', () => {
		const key = randomBytes(32);
		const encrypted = encryptValue(
			'secret',
			key,
			new TextEncoder().encode('entry:a'),
		);

		expect(() =>
			decryptValue(encrypted, key, new TextEncoder().encode('entry:b')),
		).toThrow();
	});
});

describe('encryptBytes and decryptBytes', () => {
	test('encrypt then decrypt returns original bytes', () => {
		const key = randomBytes(32);
		const plaintext = new Uint8Array([0, 1, 2, 3, 254, 255]);
		const encrypted = encryptBytes({ key, keyVersion: 4, plaintext });

		expect(
			decryptBytes({
				keyring: new Map([[4, key]]),
				blob: encrypted,
			}),
		).toEqual(plaintext);
		expect(encrypted[0]).toBe(1);
		expect(encrypted[1]).toBe(4);
		expect(encrypted.length).toBeGreaterThanOrEqual(42);
	});

	test('each encryption uses a fresh nonce', () => {
		const key = randomBytes(32);
		const plaintext = new Uint8Array([1, 2, 3]);
		const encrypted1 = encryptBytes({ key, keyVersion: 1, plaintext });
		const encrypted2 = encryptBytes({ key, keyVersion: 1, plaintext });

		expect(encrypted1).not.toEqual(encrypted2);
		expect(
			decryptBytes({ keyring: new Map([[1, key]]), blob: encrypted1 }),
		).toEqual(plaintext);
		expect(
			decryptBytes({ keyring: new Map([[1, key]]), blob: encrypted2 }),
		).toEqual(plaintext);
	});

	test('decryption fails with the wrong key', () => {
		const encrypted = encryptBytes({
			key: randomBytes(32),
			keyVersion: 1,
			plaintext: new Uint8Array([1, 2, 3]),
		});

		expect(() =>
			decryptBytes({
				keyring: new Map([[1, randomBytes(32)]]),
				blob: encrypted,
			}),
		).toThrow();
	});

	test('decryption fails when the key version is missing', () => {
		const encrypted = encryptBytes({
			key: randomBytes(32),
			keyVersion: 7,
			plaintext: new Uint8Array([1, 2, 3]),
		});

		expect(() =>
			decryptBytes({
				keyring: new Map([[1, randomBytes(32)]]),
				blob: encrypted,
			}),
		).toThrow('key version 7 is not in the keyring');
	});

	test('tampered ciphertext throws', () => {
		const key = randomBytes(32);
		const encrypted = encryptBytes({
			key,
			keyVersion: 1,
			plaintext: new Uint8Array([1, 2, 3]),
		});
		const tampered = new Uint8Array(encrypted);
		tampered[26] = (tampered[26] as number) ^ 0xff;

		expect(() =>
			decryptBytes({
				keyring: new Map([[1, key]]),
				blob: tampered as EncryptedBlob,
			}),
		).toThrow();
	});

	test('old-key blob decrypts when the keyring includes the old version', () => {
		const oldKey = randomBytes(32);
		const newKey = randomBytes(32);
		const plaintext = new Uint8Array([9, 8, 7]);
		const encrypted = encryptBytes({
			key: oldKey,
			keyVersion: 1,
			plaintext,
		});

		expect(
			decryptBytes({
				keyring: new Map([
					[2, newKey],
					[1, oldKey],
				]),
				blob: encrypted,
			}),
		).toEqual(plaintext);
	});
});

describe('isEncryptedBlob', () => {
	test('returns true for encrypted blobs', () => {
		expect(isEncryptedBlob(encryptValue('test', randomBytes(32)))).toBe(true);
	});

	test('returns false for non-byte arrays, short byte arrays, and wrong format byte', () => {
		expect(isEncryptedBlob(null)).toBe(false);
		expect(isEncryptedBlob({})).toBe(false);
		expect(isEncryptedBlob(new Uint8Array(41))).toBe(false);
		expect(isEncryptedBlob(new Uint8Array(42))).toBe(false);
	});
});

describe('base64 helpers', () => {
	test('bytesToBase64 then base64ToBytes returns original bytes', () => {
		const original = new Uint8Array(256);
		for (let i = 0; i < 256; i++) original[i] = i;

		expect(base64ToBytes(bytesToBase64(original))).toEqual(original);
	});

	test('base64ToBytes handles standard base64 strings', () => {
		const decoded = base64ToBytes('SGVsbG8gV29ybGQ=');

		expect(new TextDecoder().decode(decoded)).toBe('Hello World');
	});
});

describe('deriveWorkspaceKey', () => {
	test('different labels produce different keys', () => {
		const keyBytes = randomBytes(32);

		expect(deriveWorkspaceKey(keyBytes, 'tab-manager')).not.toEqual(
			deriveWorkspaceKey(keyBytes, 'whispering'),
		);
	});

	test('matches Web Crypto HKDF output for fixed fixtures', async () => {
		const fixtures = [
			{
				keyBytes: base64ToBytes('AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8='),
				workspaceId: 'tab-manager',
			},
			{
				keyBytes: base64ToBytes('8PHy8/T19vf4+fr7/P3+/wABAgMEBQYHCAkKCwwNDg8='),
				workspaceId: 'workspace:with:colons',
			},
		];

		for (const fixture of fixtures) {
			expect(deriveWorkspaceKey(fixture.keyBytes, fixture.workspaceId)).toEqual(
				await deriveWorkspaceKeyWithWebCrypto(
					fixture.keyBytes,
					fixture.workspaceId,
				),
			);
		}
	});
});

describe('keyringsEqual', () => {
	test('ignores order and compares key material', () => {
		const keyV1 = bytesToBase64(randomBytes(32));
		const keyV2 = bytesToBase64(randomBytes(32));

		expect(
			keyringsEqual(
				[
					{ version: 1, keyBytesBase64: keyV1 },
					{ version: 2, keyBytesBase64: keyV2 },
				],
				[
					{ version: 2, keyBytesBase64: keyV2 },
					{ version: 1, keyBytesBase64: keyV1 },
				],
			),
		).toBe(true);
		expect(
			keyringsEqual(
				[{ version: 1, keyBytesBase64: keyV1 }],
				[{ version: 1, keyBytesBase64: keyV2 }],
			),
		).toBe(false);
	});
});

describe('parseRootKeyring', () => {
	test('sorts versions descending', () => {
		expect(parseRootKeyring('1:old,3:new,2:middle')).toEqual([
			{ version: 3, secret: 'new' },
			{ version: 2, secret: 'middle' },
			{ version: 1, secret: 'old' },
		]);
	});

	test('secret values may contain colons', () => {
		expect(parseRootKeyring('1:secret:with:colons')).toEqual([
			{ version: 1, secret: 'secret:with:colons' },
		]);
	});

	test('malformed entries throw', () => {
		expect(() => parseRootKeyring('')).toThrow();
		expect(() => parseRootKeyring('1')).toThrow();
		expect(() => parseRootKeyring(':secret')).toThrow();
		expect(() => parseRootKeyring('1:')).toThrow();
		expect(() => parseRootKeyring('1:secret,with,comma')).toThrow();
	});

	test('duplicate versions and out of range versions throw', () => {
		expect(() => parseRootKeyring('2:alpha,2:bravo')).toThrow();
		expect(() => parseRootKeyring('0:secret')).toThrow();
		expect(() => parseRootKeyring('256:secret')).toThrow();
	});
});

describe('deriveKeyring', () => {
	test('derives one transport key for every root key version', async () => {
		const keyring = await deriveKeyring({
			rootKeyring: parseRootKeyring('2:new,1:old'),
			label: 'user-1',
		});

		expect(keyring).toHaveLength(2);
		expect(keyring[0]?.version).toBe(2);
		expect(keyring[1]?.version).toBe(1);
		expect(base64ToBytes(keyring[0]?.keyBytesBase64 ?? '').length).toBe(32);
	});

	// Pinning test: lock the EXACT byte output of deriveKeyring for known
	// inputs. The intent is to catch accidental edits to the HKDF info bytes
	// (`owner:${label}` prefix), salt, hash, or output length. Any change
	// that produces different bytes for these inputs breaks every existing
	// keyring derived from this deployment's ENCRYPTION_SECRETS, so the test
	// fails loudly before such a change ships.
	//
	// Format: SHA-256(secret) -> HKDF-SHA256 with salt=[], info=`owner:${label}`,
	// output 32 bytes, base64-encoded. The fixtures cover both shapes the
	// label can take in production: an opaque per-user id (personal mode)
	// and the literal `'shared'` (shared mode).
	test('output bytes are pinned (regression guard for HKDF format)', async () => {
		// Secret is base64('constant-test-secret-32-byte-seed'); a reader
		// can reproduce the expected bytes manually with `openssl base64 -d`.
		const rootKeyring = parseRootKeyring(
			'1:Y29uc3RhbnQtdGVzdC1zZWNyZXQtMzItYnl0ZS1zZWVk',
		);

		expect(await deriveKeyring({ rootKeyring, label: 'alice' })).toEqual([
			{
				version: 1,
				keyBytesBase64: 'gkn6jlaCXiVx+RCTmQfb7GhEWwC+rhrI4hdCNC0y5Rs=',
			},
		]);

		expect(await deriveKeyring({ rootKeyring, label: 'shared' })).toEqual([
			{
				version: 1,
				keyBytesBase64: '4ybZ11XJxgcWxBHJu6bg/sX5r8xquZKJKaSA4Tb1Jlk=',
			},
		]);
	});
});
