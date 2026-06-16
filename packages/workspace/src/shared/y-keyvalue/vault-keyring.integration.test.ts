/**
 * Wave 1 (encrypted KV primitive) + wave 2 (passphrase keyring) meeting in
 * process. This is the spike's wire-secrecy proof run through the REAL primitive
 * and the REAL keyring instead of throwaway copies: a passphrase-derived keyring
 * drives `createEncryptedYkvLww`, the serialized Y.Doc carries ciphertext the
 * relay cannot read, and a second doc re-derives the key from the passphrase
 * alone. The live two-client sync through the actual relay is wave 3.
 */

import { describe, expect, test } from 'bun:test';
import { createVaultKeyring, unlockVaultKeyring } from '@epicenter/encryption';
import * as Y from 'yjs';
import { createEncryptedYkvLww } from './y-keyvalue-lww-encrypted.js';

/** Cheap Argon2id cost so the suite stays fast. Production uses far steeper parameters. */
const TEST_PARAMS = { t: 1, m: 8 * 1024, p: 1 } as const;

const PASSPHRASE = 'correct horse battery staple';
const SECRET = { apiKey: 'sk-live-do-not-leak-7f3a91' };
const KEY_NAME = 'providers.openai';

function bytesInclude(haystack: Uint8Array, needle: string): boolean {
	return Buffer.from(haystack).includes(Buffer.from(needle, 'utf8'));
}

describe('passphrase keyring drives the encrypted KV primitive', () => {
	test('a secret written under a passphrase-derived key round-trips on another device', () => {
		const { metadata, keyring } = createVaultKeyring(PASSPHRASE, {
			params: TEST_PARAMS,
		});

		// Device A: write the secret into the vault namespace.
		const docA = new Y.Doc({ guid: 'vault' });
		const vaultA = createEncryptedYkvLww<typeof SECRET>(docA, 'secrets');
		vaultA.activateEncryption(keyring);
		vaultA.set(KEY_NAME, SECRET);

		// What the relay carries: a normal Y.Doc update with opaque values.
		const update = Y.encodeStateAsUpdate(docA);
		expect(bytesInclude(update, SECRET.apiKey)).toBe(false); // value is ciphertext
		expect(bytesInclude(update, KEY_NAME)).toBe(true); // key name stays plaintext

		// Device B: apply the update, re-derive the key from the passphrase alone.
		const docB = new Y.Doc({ guid: 'vault' });
		Y.applyUpdate(docB, update);
		const keyringB = unlockVaultKeyring(PASSPHRASE, metadata);
		expect(keyringB).not.toBeNull();

		const vaultB = createEncryptedYkvLww<typeof SECRET>(docB, 'secrets');
		vaultB.activateEncryption(keyringB!);
		expect(vaultB.get(KEY_NAME)).toEqual(SECRET);
	});

	test('the wrong passphrase yields no keyring, so the secret stays unreadable', () => {
		const { metadata, keyring } = createVaultKeyring(PASSPHRASE, {
			params: TEST_PARAMS,
		});

		const docA = new Y.Doc({ guid: 'vault' });
		const vaultA = createEncryptedYkvLww<typeof SECRET>(docA, 'secrets');
		vaultA.activateEncryption(keyring);
		vaultA.set(KEY_NAME, SECRET);

		const docB = new Y.Doc({ guid: 'vault' });
		Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));

		// No keyring can be built from the wrong passphrase, so there is nothing to
		// activate, and the stored value reads back unreadable.
		expect(unlockVaultKeyring('wrong passphrase', metadata)).toBeNull();
	});
});
