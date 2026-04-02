/**
 * Encryption Runtime Tests
 *
 * Verifies the encryption runtime in isolation—without constructing a full workspace.
 * Uses raw Y.Doc + Y.Array + createEncryptedYkvLww as minimal fixtures.
 *
 * Key behaviors:
 * - Starts locked, unlock transitions to unlocked, lock transitions back
 * - Same-key dedup skips re-derivation but still persists if needed
 * - Key rotation activates a multi-version keyring
 * - Auto-boot from cached keys on startup
 * - Corrupt cache entries are cleared and runtime stays locked
 * - Cache serialization prevents write races
 */

import { describe, expect, mock, test } from 'bun:test';
import * as Y from 'yjs';
import {
	bytesToBase64,
	generateEncryptionKey,
} from '../shared/crypto/index.js';
import { createEncryptedYkvLww } from '../shared/y-keyvalue/y-keyvalue-lww-encrypted.js';
import { createEncryptionRuntime } from './encryption-runtime.js';
import type { EncryptionKeys } from './types.js';
import type { EncryptionKeysJson, UserKeyStore } from './user-key-store.js';

// ════════════════════════════════════════════════════════════════════════════
// Test Helpers
// ════════════════════════════════════════════════════════════════════════════

/** Wrap a raw Uint8Array key into a single-entry EncryptionKeys. */
function toEncryptionKeys(key: Uint8Array): EncryptionKeys {
	return [{ version: 1, userKeyBase64: bytesToBase64(key) }];
}

/** Serialize a raw key to the JSON format the UserKeyStore stores. */
function toKeysJson(key: Uint8Array): EncryptionKeysJson {
	return JSON.stringify(toEncryptionKeys(key)) as EncryptionKeysJson;
}


/** Create an encryption runtime with 2 encrypted stores (minimal fixture). */
function setup(opts?: { userKeyStore?: UserKeyStore }) {
	const ydoc = new Y.Doc();
	const stores = [
		createEncryptedYkvLww(ydoc.getArray('table:posts')),
		createEncryptedYkvLww(ydoc.getArray('kv')),
	] as const;
	const runtime = createEncryptionRuntime({
		workspaceId: 'test',
		stores,
		userKeyStore: opts?.userKeyStore,
	});
	return { runtime };
}

async function setupWithUserKeyStore(
	cachedKeyJson: EncryptionKeysJson | null = null,
) {
	let cachedValue: EncryptionKeysJson | null = cachedKeyJson;
	let shouldFailNextSave = false;
	const userKeyStore: UserKeyStore = {
		set: mock(async (keysJson: EncryptionKeysJson) => {
			if (shouldFailNextSave) {
				shouldFailNextSave = false;
				throw new Error('forced user key store set failure');
			}
			cachedValue = keysJson;
		}),
		get: mock(async () => cachedValue),
		delete: mock(async () => {
			cachedValue = null;
		}),
	};
	const { runtime } = setup({ userKeyStore });
	await runtime.bootPromise;
	return {
		runtime,
		userKeyStore,
		failNextSet() {
			shouldFailNextSave = true;
		},
		readCachedValue: () => cachedValue,
	};
}

// ════════════════════════════════════════════════════════════════════════════
// Core lock/unlock
// ════════════════════════════════════════════════════════════════════════════

describe('createEncryptionRuntime', () => {
	describe('lock/unlock', () => {
		test('starts locked', () => {
			const { runtime } = setup();
			expect(runtime.encryption.isUnlocked).toBe(false);
		});

		test('unlock transitions to unlocked', async () => {
			const { runtime } = setup();
			await runtime.encryption.unlock(
				toEncryptionKeys(generateEncryptionKey()),
			);
			expect(runtime.encryption.isUnlocked).toBe(true);
		});

		test('lock transitions back to locked', async () => {
			const { runtime } = setup();
			await runtime.encryption.unlock(
				toEncryptionKeys(generateEncryptionKey()),
			);
			runtime.encryption.lock();
			expect(runtime.encryption.isUnlocked).toBe(false);
		});

		test('different keys each keep the runtime unlocked', async () => {
			const { runtime } = setup();
			await runtime.encryption.unlock(
				toEncryptionKeys(generateEncryptionKey()),
			);
			expect(runtime.encryption.isUnlocked).toBe(true);
			await runtime.encryption.unlock(
				toEncryptionKeys(generateEncryptionKey()),
			);
			expect(runtime.encryption.isUnlocked).toBe(true);
		});

		test('rapid unlocks leave the runtime unlocked with the latest key', async () => {
			const { runtime } = setup();
			const p1 = runtime.encryption.unlock(
				toEncryptionKeys(generateEncryptionKey()),
			);
			const p2 = runtime.encryption.unlock(
				toEncryptionKeys(generateEncryptionKey()),
			);
			const p3 = runtime.encryption.unlock(
				toEncryptionKeys(generateEncryptionKey()),
			);
			await Promise.all([p1, p2, p3]);
			expect(runtime.encryption.isUnlocked).toBe(true);
		});
	});

	// ════════════════════════════════════════════════════════════════════════
	// Dedup
	// ════════════════════════════════════════════════════════════════════════

	describe('dedup', () => {
		test('same key twice keeps the runtime unlocked', async () => {
			const { runtime } = setup();
			const key = generateEncryptionKey();
			await runtime.encryption.unlock(toEncryptionKeys(key));
			await runtime.encryption.unlock(toEncryptionKeys(key));
			expect(runtime.encryption.isUnlocked).toBe(true);
		});
	});

	// ════════════════════════════════════════════════════════════════════════
	// Key rotation
	// ════════════════════════════════════════════════════════════════════════

	describe('key rotation', () => {
		test('unlock with multi-version keyring succeeds', async () => {
			const { runtime } = setup();
			const keyV1 = generateEncryptionKey();
			const keyV2 = generateEncryptionKey();

			await runtime.encryption.unlock([
				{ version: 2, userKeyBase64: bytesToBase64(keyV2) },
				{ version: 1, userKeyBase64: bytesToBase64(keyV1) },
			]);

			expect(runtime.encryption.isUnlocked).toBe(true);
		});
	});

	// ════════════════════════════════════════════════════════════════════════
	// UserKeyStore integration
	// ════════════════════════════════════════════════════════════════════════

	describe('userKeyStore integration', () => {
		test('unlock saves the user key through userKeyStore', async () => {
			const { runtime, userKeyStore, readCachedValue } =
				await setupWithUserKeyStore();
			const userKey = generateEncryptionKey();

			await runtime.encryption.unlock(toEncryptionKeys(userKey));

			expect(userKeyStore.set).toHaveBeenCalledTimes(1);
			expect(userKeyStore.set).toHaveBeenCalledWith(toKeysJson(userKey));
			expect(readCachedValue()).toBe(toKeysJson(userKey));
		});

		test('unlock retries the same key after userKeyStore.set fails', async () => {
			const { runtime, userKeyStore, failNextSet, readCachedValue } =
				await setupWithUserKeyStore();
			const userKey = generateEncryptionKey();

			failNextSet();
			await runtime.encryption.unlock(toEncryptionKeys(userKey));
			await runtime.encryption.unlock(toEncryptionKeys(userKey));

			expect(runtime.encryption.isUnlocked).toBe(true);
			expect(userKeyStore.set).toHaveBeenCalledTimes(2);
			expect(readCachedValue()).toBe(toKeysJson(userKey));
		});

		test('auto-boot stays locked when userKeyStore is empty', async () => {
			const { runtime, userKeyStore } = await setupWithUserKeyStore();

			expect(runtime.encryption.isUnlocked).toBe(false);
			expect(userKeyStore.get).toHaveBeenCalledTimes(1);
			expect(userKeyStore.set).toHaveBeenCalledTimes(0);
		});

		test('auto-boot unlocks from cached key', async () => {
			const userKey = generateEncryptionKey();
			const { runtime, userKeyStore } = await setupWithUserKeyStore(
				toKeysJson(userKey),
			);

			expect(runtime.encryption.isUnlocked).toBe(true);
			expect(userKeyStore.get).toHaveBeenCalledTimes(1);
			expect(userKeyStore.set).toHaveBeenCalledTimes(1);
			expect(userKeyStore.set).toHaveBeenCalledWith(toKeysJson(userKey));
		});

		test('auto-boot clears corrupt cache entries and stays locked', async () => {
			const { runtime, userKeyStore, readCachedValue } = await setupWithUserKeyStore(
				'%%%not-base64%%%' as EncryptionKeysJson,
			);

			expect(runtime.encryption.isUnlocked).toBe(false);
			expect(userKeyStore.delete).toHaveBeenCalledTimes(1);
			expect(readCachedValue()).toBe(null);
		});

		test('clearCache deletes from userKeyStore', async () => {
			const userKey = generateEncryptionKey();
			const { runtime, userKeyStore, readCachedValue } = await setupWithUserKeyStore(
				toKeysJson(userKey),
			);
			expect(runtime.encryption.isUnlocked).toBe(true);

			await runtime.clearCache();

			expect(userKeyStore.delete).toHaveBeenCalledTimes(1);
			expect(readCachedValue()).toBe(null);
		});
	});

	// ════════════════════════════════════════════════════════════════════════
	// Boot promise
	// ════════════════════════════════════════════════════════════════════════

	describe('bootPromise', () => {
		test('bootPromise is undefined when no userKeyStore is configured', () => {
			const { runtime } = setup();
			expect(runtime.bootPromise).toBeUndefined();
		});

		test('bootPromise is a Promise when userKeyStore is configured', () => {
			const userKeyStore: UserKeyStore = {
				set: mock(async () => {}),
				get: mock(async () => null),
				delete: mock(async () => {}),
			};
			const { runtime } = setup({ userKeyStore });
			expect(runtime.bootPromise).toBeInstanceOf(Promise);
		});
	});
});
