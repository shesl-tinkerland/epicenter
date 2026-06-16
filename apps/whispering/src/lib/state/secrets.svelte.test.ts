import { beforeEach, expect, mock, test } from 'bun:test';
import { Ok, type Result } from 'wellcrafted/result';
import type { SecretKey } from './device-config.svelte';
import { type Vault, VaultError, type VaultState } from './vault';

// The repo tests rune-bearing `.svelte.ts` modules under plain `bun test` by
// stubbing `$state` as identity: we exercise logic, not Svelte reactivity (see
// `packages/svelte-utils/src/session.svelte.test.ts`).
(globalThis as unknown as { $state: <T>(value: T) => T }).$state = (value) =>
	value;

// The facade reaches `deviceConfig`, `$lib/report`, and (in its singleton)
// `attachIndexedDb` through browser-only module chains (`#platform`, `$lib`,
// IndexedDB) that do not resolve under bun. Mock those three leaves so importing
// the module is safe; the vault is injected per test as a faithful fake, so no
// real crypto runs here (the real vault is covered by `vault.test.ts`).
const deviceStore = new Map<string, string>();
let reportErrorCalls = 0;

mock.module('@epicenter/workspace', () => ({
	attachIndexedDb: () => ({ whenLoaded: Promise.resolve() }),
}));
mock.module('$lib/report', () => ({
	report: {
		error: () => {
			reportErrorCalls += 1;
		},
	},
}));
mock.module('./device-config.svelte', () => ({
	deviceConfig: {
		get: (key: string) => deviceStore.get(key) ?? '',
		set: (key: string, value: string) => {
			deviceStore.set(key, value);
		},
	},
	SECRET_KEYS: ['providers.openai.apiKey', 'providers.groq.apiKey'],
}));

const { createSecrets } = await import('./secrets.svelte');

const OPENAI = 'providers.openai.apiKey' as SecretKey;
const GROQ = 'providers.groq.apiKey' as SecretKey;

/**
 * A faithful in-memory stand-in for the vault: the same lock state machine and
 * read/write semantics `createVault` exposes, without the crypto. It lets the
 * facade tests stay fast and black-box (drive the vault only through the facade).
 */
function createFakeVault(): Vault {
	let state: VaultState = 'absent';
	const store = new Map<string, string>();
	const listeners = new Set<() => void>();
	const emit = () => {
		for (const listener of listeners) listener();
	};
	return {
		get state() {
			return state;
		},
		whenReady: Promise.resolve(),
		onChange(listener: () => void): () => void {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		provision(): Result<void, VaultError> {
			if (state !== 'absent') return VaultError.VaultAlreadyProvisioned();
			state = 'unlocked';
			emit();
			return Ok(undefined);
		},
		unlock(): Result<void, VaultError> {
			if (state === 'absent') return VaultError.VaultNotProvisioned();
			state = 'unlocked';
			return Ok(undefined);
		},
		lock(): void {
			if (state === 'unlocked') state = 'locked';
		},
		destroy(): void {
			store.clear();
			state = 'absent';
			emit();
		},
		get(key: string): string | undefined {
			return state === 'unlocked' ? store.get(key) : undefined;
		},
		set(key: string, value: string): Result<void, VaultError> {
			if (state !== 'unlocked') return VaultError.VaultLocked();
			store.set(key, value);
			emit();
			return Ok(undefined);
		},
	};
}

beforeEach(() => {
	deviceStore.clear();
	reportErrorCalls = 0;
});

test('a read before whenReady reports loudly (the boot gate)', () => {
	const secrets = createSecrets({ vault: createFakeVault() });
	// No `await secrets.whenReady`: the gate has not resolved.
	secrets.get(OPENAI);
	expect(reportErrorCalls).toBe(1);
});

test('an unset device key reads as missing, not available("")', async () => {
	const secrets = createSecrets({ vault: createFakeVault() });
	await secrets.whenReady;
	expect(secrets.get(OPENAI)).toEqual({ status: 'missing' });
});

test('a device-stored secret reads as available and lives on the device', async () => {
	const secrets = createSecrets({ vault: createFakeVault() });
	await secrets.whenReady;
	secrets.set(OPENAI, 'sk-device');
	expect(secrets.get(OPENAI)).toEqual({
		status: 'available',
		value: 'sk-device',
	});
	expect(deviceStore.get(OPENAI)).toBe('sk-device');
});

test('enableSync migrates device secrets into the vault and clears the device copy', async () => {
	const secrets = createSecrets({ vault: createFakeVault() });
	await secrets.whenReady;
	secrets.set(OPENAI, 'sk-device');

	const result = secrets.enableSync('correct horse battery staple');
	expect(result.error).toBeNull();
	expect(secrets.status).toBe('unlocked');
	expect(deviceStore.get(OPENAI)).toBe(''); // device copy cleared, no plaintext lingers
	expect(secrets.get(OPENAI)).toEqual({
		status: 'available',
		value: 'sk-device',
	}); // now from the vault
});

test('a locked vault reads as locked and refuses writes', async () => {
	const secrets = createSecrets({ vault: createFakeVault() });
	await secrets.whenReady;
	secrets.set(OPENAI, 'sk-device');
	secrets.enableSync('pw');
	secrets.lock();

	expect(secrets.status).toBe('locked');
	expect(secrets.get(OPENAI)).toEqual({ status: 'locked' });
	expect(secrets.set(OPENAI, 'sk-new').error?.name).toBe('VaultLocked');
});

test('disableSync moves vault secrets back to the device', async () => {
	const secrets = createSecrets({ vault: createFakeVault() });
	await secrets.whenReady;
	secrets.set(OPENAI, 'sk-device');
	secrets.enableSync('pw');

	const result = secrets.disableSync();
	expect(result.error).toBeNull();
	expect(secrets.status).toBe('device-only');
	expect(deviceStore.get(OPENAI)).toBe('sk-device'); // migrated back
	expect(secrets.get(OPENAI)).toEqual({
		status: 'available',
		value: 'sk-device',
	});
});

test('disableSync on a locked vault refuses (it cannot read values to migrate)', async () => {
	const secrets = createSecrets({ vault: createFakeVault() });
	await secrets.whenReady;
	secrets.enableSync('pw');
	secrets.lock();
	expect(secrets.disableSync().error?.name).toBe('VaultLocked');
});

test('forget abandons a locked vault back to device-only, losing the values', async () => {
	const secrets = createSecrets({ vault: createFakeVault() });
	await secrets.whenReady;
	secrets.set(OPENAI, 'sk-device');
	secrets.enableSync('pw'); // device copy cleared
	secrets.lock(); // forgot the passphrase

	secrets.forget();
	expect(secrets.status).toBe('device-only');
	// The value is gone: enableSync cleared the device copy, and an unreadable
	// vault was wiped. The user re-enters the regenerable key.
	expect(secrets.get(OPENAI)).toEqual({ status: 'missing' });
});

test('only the named secret keys migrate; an unset one stays empty', async () => {
	const secrets = createSecrets({ vault: createFakeVault() });
	await secrets.whenReady;
	secrets.set(OPENAI, 'sk-device');
	secrets.enableSync('pw'); // GROQ was never set

	expect(secrets.get(OPENAI)).toEqual({
		status: 'available',
		value: 'sk-device',
	});
	expect(secrets.get(GROQ)).toEqual({ status: 'missing' });
});
