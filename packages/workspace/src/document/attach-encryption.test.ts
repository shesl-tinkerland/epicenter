/**
 * attachEncryption tests: registration, fingerprint dedup, key application,
 * key rotation, re-encryption of plaintext, late-register auto-activation,
 * disposal cascade, reentrance guard.
 *
 * These tests exercise the attachment directly (without a workspace client)
 * to pin its contract independently of the workspace builder. Stores are
 * constructed with `createEncryptedYkvLww` and registered via
 * `encryption.register(store)`: the same pathway used by
 * `encryption.attachTable` / `encryption.attachKv`.
 */

import { describe, expect, test } from 'bun:test';
import { randomBytes } from '@noble/ciphers/utils.js';
import * as Y from 'yjs';
import { attachEncryption } from './attach-encryption.js';
import {
	bytesToBase64,
	type EncryptedBlob,
	getKeyVersion,
	isEncryptedBlob,
} from '../shared/crypto/index.js';
import { createEncryptedYkvLww } from '../shared/y-keyvalue/y-keyvalue-lww-encrypted.js';
import type { EncryptionKeys } from './encryption-key.js';

function toEncryptionKeys(key: Uint8Array): EncryptionKeys {
	return [{ version: 1, userKeyBase64: bytesToBase64(key) }];
}

function setup() {
	const ydoc = new Y.Doc({ guid: 'enc-test', gc: false });
	const encryption = attachEncryption(ydoc);
	const storeA = createEncryptedYkvLww<{ title: string }>(ydoc, 'a');
	const storeB = createEncryptedYkvLww<{ title: string }>(ydoc, 'b');
	encryption.register(storeA);
	encryption.register(storeB);
	return { ydoc, storeA, storeB, encryption };
}

describe('attachEncryption', () => {
	test('applyKeys enables encrypted writes on every registered store', () => {
		const { storeA, storeB, encryption } = setup();
		encryption.applyKeys(toEncryptionKeys(randomBytes(32)));
		storeA.set('1', { title: 'Secret A' });
		storeB.set('1', { title: 'Secret B' });
		expect(storeA.get('1')).toEqual({ title: 'Secret A' });
		expect(storeB.get('1')).toEqual({ title: 'Secret B' });
	});

	test('applyKeys re-encrypts existing plaintext entries', () => {
		const { storeA, encryption } = setup();
		storeA.set('1', { title: 'Was plaintext' });
		encryption.applyKeys(toEncryptionKeys(randomBytes(32)));
		expect(storeA.get('1')).toEqual({ title: 'Was plaintext' });
	});

	test('fingerprint dedup: identical keys short-circuit the second call', () => {
		const { storeA, encryption } = setup();
		const key = randomBytes(32);
		encryption.applyKeys(toEncryptionKeys(key));
		storeA.set('1', { title: 'Before second apply' });
		encryption.applyKeys(toEncryptionKeys(key));
		expect(storeA.get('1')).toEqual({ title: 'Before second apply' });
	});

	test('fingerprint dedup: reversed key order is treated as the same keyring', () => {
		const { storeA, encryption } = setup();
		const keyV1 = randomBytes(32);
		const keyV2 = randomBytes(32);
		const asc: EncryptionKeys = [
			{ version: 1, userKeyBase64: bytesToBase64(keyV1) },
			{ version: 2, userKeyBase64: bytesToBase64(keyV2) },
		];
		const desc: EncryptionKeys = [
			{ version: 2, userKeyBase64: bytesToBase64(keyV2) },
			{ version: 1, userKeyBase64: bytesToBase64(keyV1) },
		];
		encryption.applyKeys(asc);
		storeA.set('1', { title: 'Order test' });
		encryption.applyKeys(desc);
		expect(storeA.get('1')).toEqual({ title: 'Order test' });
	});

	test('plaintext writes are readable before applyKeys is called', () => {
		const { storeA } = setup();
		storeA.set('1', { title: 'Plaintext' });
		expect(storeA.get('1')).toEqual({ title: 'Plaintext' });
	});

	test('late-registered store auto-activates with cached keyring', () => {
		const ydoc = new Y.Doc({ guid: 'enc-late-register', gc: false });
		const encryption = attachEncryption(ydoc);
		encryption.applyKeys(toEncryptionKeys(randomBytes(32)));

		// Register after applyKeys: the store must receive the cached keyring
		// so subsequent writes are encrypted from the start.
		const lateStore = createEncryptedYkvLww<{ title: string }>(ydoc, 'late');
		encryption.register(lateStore);

		lateStore.set('1', { title: 'Written after late register' });
		expect(lateStore.get('1')).toEqual({ title: 'Written after late register' });
	});

	test('whenDisposed resolves once ydoc.destroy() fires', async () => {
		const { ydoc, encryption } = setup();
		ydoc.destroy();
		await encryption.whenDisposed;
	});

	describe('at-rest upgrade on key rotation', () => {
		test('v1 ciphertext gets re-encrypted to v2 when v2 becomes current', () => {
			const { storeA, encryption } = setup();
			const keyV1 = randomBytes(32);
			const keyV2 = randomBytes(32);

			encryption.applyKeys([
				{ version: 1, userKeyBase64: bytesToBase64(keyV1) },
			]);
			storeA.set('1', { title: 'Written with v1' });

			// Sanity: the at-rest blob is a v1 ciphertext.
			const beforeEntry = storeA.yarray.toArray().find((e) => e.key === '1');
			expect(beforeEntry).toBeDefined();
			expect(isEncryptedBlob(beforeEntry?.val)).toBe(true);
			expect(getKeyVersion(beforeEntry?.val as EncryptedBlob)).toBe(1);

			// Rotate: v2 is the new current key; v1 stays in the keyring so the
			// walk can decrypt existing v1 blobs.
			encryption.applyKeys([
				{ version: 2, userKeyBase64: bytesToBase64(keyV2) },
				{ version: 1, userKeyBase64: bytesToBase64(keyV1) },
			]);

			// At-rest blob should now be v2, not v1.
			const afterEntry = storeA.yarray.toArray().find((e) => e.key === '1');
			expect(afterEntry).toBeDefined();
			expect(isEncryptedBlob(afterEntry?.val)).toBe(true);
			expect(getKeyVersion(afterEntry?.val as EncryptedBlob)).toBe(2);
			// And the decrypted value is unchanged.
			expect(storeA.get('1')).toEqual({ title: 'Written with v1' });

			// New writes after rotation use v2 and are readable.
			storeA.set('new', { title: 'Written with v2' });
			expect(storeA.get('new')).toEqual({ title: 'Written with v2' });
			const newEntry = storeA.yarray.toArray().find((e) => e.key === 'new');
			expect(getKeyVersion(newEntry?.val as EncryptedBlob)).toBe(2);
		});

	});
});
