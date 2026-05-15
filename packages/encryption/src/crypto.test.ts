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
	buildSubjectKeyring,
	bytesToBase64,
	decryptBytes,
	decryptValue,
	deriveKeyFromPassword,
	deriveSubjectKeyring,
	deriveWorkspaceKey,
	type EncryptedBlob,
	encryptBytes,
	encryptValue,
	formatRootKeyring,
	generateSalt,
	getKeyVersion,
	isEncryptedBlob,
	PBKDF2_ITERATIONS_DEFAULT,
	parseRootKeyring,
	subjectKeyringsEqual,
} from './index.js';

async function deriveWorkspaceKeyWithWebCrypto(
	subjectKey: Uint8Array,
	workspaceId: string,
): Promise<Uint8Array> {
	const hkdfKey = await crypto.subtle.importKey(
		'raw',
		new Uint8Array(subjectKey).buffer,
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
		expect(() => buildSubjectKeyring(key, 0)).toThrow();
		expect(() => buildSubjectKeyring(key, 256)).toThrow();
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
	test('same inputs produce same key and different labels produce different keys', () => {
		const subjectKey = randomBytes(32);

		expect(deriveWorkspaceKey(subjectKey, 'tab-manager')).toEqual(
			deriveWorkspaceKey(subjectKey, 'tab-manager'),
		);
		expect(deriveWorkspaceKey(subjectKey, 'tab-manager')).not.toEqual(
			deriveWorkspaceKey(subjectKey, 'whispering'),
		);
	});

	test('matches Web Crypto HKDF output for fixed fixtures', async () => {
		const fixtures = [
			{
				subjectKey: base64ToBytes(
					'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=',
				),
				workspaceId: 'tab-manager',
			},
			{
				subjectKey: base64ToBytes(
					'8PHy8/T19vf4+fr7/P3+/wABAgMEBQYHCAkKCwwNDg8=',
				),
				workspaceId: 'workspace:with:colons',
			},
		];

		for (const fixture of fixtures) {
			expect(deriveWorkspaceKey(fixture.subjectKey, fixture.workspaceId)).toEqual(
				await deriveWorkspaceKeyWithWebCrypto(
					fixture.subjectKey,
					fixture.workspaceId,
				),
			);
		}
	});
});

describe('deriveKeyFromPassword and generateSalt', () => {
	test('password derivation is deterministic for the same salt', () => {
		const salt = randomBytes(32);

		expect(deriveKeyFromPassword('hunter2', salt)).toEqual(
			deriveKeyFromPassword('hunter2', salt),
		);
		expect(deriveKeyFromPassword('hunter2', salt)).not.toEqual(
			deriveKeyFromPassword('password2', salt),
		);
		expect(PBKDF2_ITERATIONS_DEFAULT).toBe(600_000);
	});

	test('generateSalt returns fresh 32 byte salts', () => {
		const salt1 = generateSalt();
		const salt2 = generateSalt();

		expect(salt1.length).toBe(32);
		expect(salt2.length).toBe(32);
		expect(salt1).not.toEqual(salt2);
	});
});

describe('buildSubjectKeyring and subjectKeyringsEqual', () => {
	test('buildSubjectKeyring returns transport keys that round trip through base64', () => {
		const subjectKey = randomBytes(32);
		const keyring = buildSubjectKeyring(subjectKey, 3);

		expect(keyring).toEqual([
			{ version: 3, subjectKeyBase64: bytesToBase64(subjectKey) },
		]);
		expect(base64ToBytes(keyring[0].subjectKeyBase64)).toEqual(subjectKey);
	});

	test('subjectKeyringsEqual ignores order and compares key material', () => {
		const keyV1 = bytesToBase64(randomBytes(32));
		const keyV2 = bytesToBase64(randomBytes(32));

		expect(
			subjectKeyringsEqual(
				[
					{ version: 1, subjectKeyBase64: keyV1 },
					{ version: 2, subjectKeyBase64: keyV2 },
				],
				[
					{ version: 2, subjectKeyBase64: keyV2 },
					{ version: 1, subjectKeyBase64: keyV1 },
				],
			),
		).toBe(true);
		expect(
			subjectKeyringsEqual(
				[{ version: 1, subjectKeyBase64: keyV1 }],
				[{ version: 1, subjectKeyBase64: keyV2 }],
			),
		).toBe(false);
	});
});

describe('parseRootKeyring and formatRootKeyring', () => {
	test('parseRootKeyring sorts versions descending', () => {
		expect(parseRootKeyring('1:old,3:new,2:middle')).toEqual([
			{ version: 3, secret: 'new' },
			{ version: 2, secret: 'middle' },
			{ version: 1, secret: 'old' },
		]);
	});

	test('formatRootKeyring emits canonical descending order', () => {
		expect(
			formatRootKeyring([
				{ version: 1, secret: 'old' },
				{ version: 2, secret: 'new' },
			]),
		).toBe('2:new,1:old');
	});

	test('secret values may contain colons', () => {
		expect(parseRootKeyring('1:secret:with:colons')).toEqual([
			{ version: 1, secret: 'secret:with:colons' },
		]);
	});

	test('round trip preserves canonical representation', () => {
		const formatted = formatRootKeyring(parseRootKeyring('1:old,2:new'));

		expect(formatted).toBe('2:new,1:old');
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
		expect(() =>
			formatRootKeyring([
				{ version: 1, secret: 'a' },
				{ version: 1, secret: 'b' },
			]),
		).toThrow();
	});
});

describe('deriveSubjectKeyring', () => {
	test('derives one transport key for every root key version', async () => {
		const keyring = await deriveSubjectKeyring({
			rootKeyring: parseRootKeyring('2:new,1:old'),
			subject: 'user-1',
		});

		expect(keyring).toHaveLength(2);
		expect(keyring[0]?.version).toBe(2);
		expect(keyring[1]?.version).toBe(1);
		expect(base64ToBytes(keyring[0]?.subjectKeyBase64 ?? '').length).toBe(32);
	});

	test('same root keyring and subject derive the same transport keys', async () => {
		const input = {
			rootKeyring: parseRootKeyring('1:secret'),
			subject: 'user-1',
		};

		expect(await deriveSubjectKeyring(input)).toEqual(
			await deriveSubjectKeyring(input),
		);
	});
});
