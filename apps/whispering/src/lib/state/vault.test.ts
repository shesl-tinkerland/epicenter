import { describe, expect, test } from 'bun:test';
import type { Argon2Params } from '@epicenter/encryption';
import * as Y from 'yjs';
import { createVault } from './vault';

/** Cheap Argon2id cost so derivation stays fast in tests (matches the keyring suite). */
const TEST_PARAMS: Argon2Params = { t: 1, m: 8 * 1024, p: 1 };

/** A vault over a bare in-memory Y.Doc, already hydrated. No IndexedDB, no relay. */
async function setupVault(ydoc: Y.Doc = new Y.Doc()) {
	const vault = createVault({
		ydoc,
		whenLoaded: Promise.resolve(),
		argon2Params: TEST_PARAMS,
	});
	await vault.whenReady;
	return vault;
}

describe('vault lock lifecycle', () => {
	test('starts absent and provisions to unlocked', async () => {
		const vault = await setupVault();
		expect(vault.state).toBe('absent');

		const result = vault.provision('correct horse battery staple');
		expect(result.error).toBeNull();
		expect(vault.state).toBe('unlocked');
	});

	test('reads back what it wrote while unlocked', async () => {
		const vault = await setupVault();
		vault.provision('correct horse battery staple');

		vault.set('providers.openai.apiKey', 'sk-test-123');
		expect(vault.get('providers.openai.apiKey')).toBe('sk-test-123');
	});

	test('locking drops the key: reads return undefined, writes fail', async () => {
		const vault = await setupVault();
		vault.provision('correct horse battery staple');
		vault.set('providers.openai.apiKey', 'sk-test-123');

		vault.lock();
		expect(vault.state).toBe('locked');
		expect(vault.get('providers.openai.apiKey')).toBeUndefined();

		const write = vault.set('providers.openai.apiKey', 'sk-test-456');
		expect(write.error?.name).toBe('VaultLocked');
	});

	test('a wrong passphrase does not unlock; the right one does', async () => {
		const vault = await setupVault();
		vault.provision('correct horse battery staple');
		vault.set('providers.openai.apiKey', 'sk-test-123');
		vault.lock();

		const wrong = vault.unlock('wrong passphrase entirely');
		expect(wrong.error?.name).toBe('WrongPassphrase');
		expect(vault.state).toBe('locked');

		const right = vault.unlock('correct horse battery staple');
		expect(right.error).toBeNull();
		expect(vault.state).toBe('unlocked');
		expect(vault.get('providers.openai.apiKey')).toBe('sk-test-123');
	});

	test('a reload re-derives locked from persisted metadata, not the key', async () => {
		const ydoc = new Y.Doc();
		const first = await setupVault(ydoc);
		first.provision('correct horse battery staple');
		first.set('providers.openai.apiKey', 'sk-test-123');

		// Simulate reload: a fresh handle over the same (persisted) doc, no key in memory.
		const reloaded = await setupVault(ydoc);
		expect(reloaded.state).toBe('locked');
		expect(reloaded.get('providers.openai.apiKey')).toBeUndefined();

		reloaded.unlock('correct horse battery staple');
		expect(reloaded.get('providers.openai.apiKey')).toBe('sk-test-123');
	});

	test('destroy clears the vault back to absent', async () => {
		const vault = await setupVault();
		vault.provision('correct horse battery staple');
		vault.set('providers.openai.apiKey', 'sk-test-123');

		vault.destroy();
		expect(vault.state).toBe('absent');
		expect(vault.provision('a different passphrase here').error).toBeNull();
		expect(vault.get('providers.openai.apiKey')).toBeUndefined();
	});

	test('the serialized update never contains the plaintext secret', async () => {
		const ydoc = new Y.Doc();
		const vault = await setupVault(ydoc);
		vault.provision('correct horse battery staple');
		vault.set('providers.openai.apiKey', 'sk-PLAINTEXT-SECRET');

		const update = Y.encodeStateAsUpdate(ydoc);
		const text = new TextDecoder().decode(update);
		expect(text).not.toContain('sk-PLAINTEXT-SECRET');
		// The key name stays visible; only the value is ciphertext.
		expect(text).toContain('providers.openai.apiKey');
	});
});
