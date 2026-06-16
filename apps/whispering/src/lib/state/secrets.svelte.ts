import { attachIndexedDb } from '@epicenter/workspace';
import { Ok, type Result } from 'wellcrafted/result';
import * as Y from 'yjs';
import { type DeviceConfigKey, deviceConfig } from './device-config.svelte';
import { createVault, type Vault, VaultError, type VaultState } from './vault';

/**
 * The credential facade: the one place the app reads and writes provider
 * secrets. It owns the choice between two storage homes and hides nothing that
 * matters.
 *
 * - device home (the default): plaintext `localStorage` via `deviceConfig`,
 *   never synced, the smallest attack surface when you do not sync.
 * - vault home (opt-in): the end-to-end-encrypted, synced {@link Vault}.
 *
 * A secret has exactly one home at a time. Enabling sync *migrates* each secret
 * off the device into the vault and clears the device copy; disabling migrates
 * back. This is not VS Code-style layered override resolution (ADR 0004 rejected
 * that): there is no precedence stack, just a single runtime-chosen home, which
 * is the one place ADR 0004 allows destination to be a user choice.
 *
 * Reads return an explicit {@link SecretRead}, never a blank string for a locked
 * vault, so a caller can tell "not unlocked yet" apart from "never set". That is
 * a normal control-flow outcome, not an error, which is why reads return a union
 * and the mutating operations return `Result`.
 */

/**
 * The provider-key device entries that are secrets. These are the keys the
 * facade routes between the device and the vault, and the set it migrates on
 * sync enable/disable. ADR 0004's secret-name guard test keeps account-synced KV
 * from ever matching one of these.
 */
const SECRET_KEYS = [
	'providers.openai.apiKey',
	'providers.anthropic.apiKey',
	'providers.groq.apiKey',
	'providers.google.apiKey',
	'providers.deepgram.apiKey',
	'providers.elevenlabs.apiKey',
	'providers.mistral.apiKey',
	'providers.openrouter.apiKey',
	'providers.custom.apiKey',
] as const satisfies readonly DeviceConfigKey[];

export type SecretKey = (typeof SECRET_KEYS)[number];

/**
 * The outcome of reading a secret. `available` carries the value (possibly an
 * empty string when device-stored and unset); `locked` means the vault holds it
 * but is not open; `missing` means no value is stored in the current home.
 */
export type SecretRead =
	| { status: 'available'; value: string }
	| { status: 'locked' }
	| { status: 'missing' };

/** Where secrets currently live, as the settings toggle sees it. */
export type SyncStatus = 'device-only' | 'locked' | 'unlocked';

function toSyncStatus(state: VaultState): SyncStatus {
	return state === 'absent' ? 'device-only' : state;
}

function createSecrets({ vault }: { vault: Vault }) {
	let status = $state<SyncStatus>('device-only');

	/** Mirror the vault's state into the reactive status. Called after every transition. */
	function refresh(): void {
		status = toSyncStatus(vault.state);
	}

	const whenReady = vault.whenReady.then(refresh);

	return {
		/** Reactive view of where secrets live, for the settings toggle. */
		get status(): SyncStatus {
			return status;
		},

		/** Resolves once the vault has hydrated and {@link status} is settled. */
		whenReady,

		/**
		 * Read a secret from its current home. Device-stored secrets resolve
		 * immediately; vault-stored secrets need the vault unlocked, otherwise this
		 * returns `locked` so the caller can prompt instead of using a blank key.
		 */
		async get(key: SecretKey): Promise<SecretRead> {
			await whenReady;
			if (vault.state === 'absent') {
				return { status: 'available', value: deviceConfig.get(key) };
			}
			if (vault.state === 'locked') return { status: 'locked' };
			const value = vault.get(key);
			return value === undefined
				? { status: 'missing' }
				: { status: 'available', value };
		},

		/** Write a secret to its current home. Fails with `VaultLocked` while locked. */
		async set(
			key: SecretKey,
			value: string,
		): Promise<Result<void, VaultError>> {
			await whenReady;
			if (vault.state === 'absent') {
				deviceConfig.set(key, value);
				return Ok(undefined);
			}
			return vault.set(key, value);
		},

		/**
		 * Turn on cross-device sync: provision the vault, move every device secret
		 * into it, and clear the device copies so no plaintext key lingers. The
		 * vault is left unlocked.
		 */
		async enableSync(passphrase: string): Promise<Result<void, VaultError>> {
			await whenReady;
			const provisioned = vault.provision(passphrase);
			if (provisioned.error) return provisioned;
			for (const key of SECRET_KEYS) {
				const deviceValue = deviceConfig.get(key);
				if (deviceValue) vault.set(key, deviceValue);
			}
			for (const key of SECRET_KEYS) deviceConfig.set(key, '');
			refresh();
			return Ok(undefined);
		},

		/**
		 * Turn off sync: move every vault secret back to the device and destroy the
		 * vault. Requires the vault unlocked, since the values must be read to move
		 * them; a locked vault returns `VaultLocked`.
		 */
		async disableSync(): Promise<Result<void, VaultError>> {
			await whenReady;
			if (vault.state === 'absent') return Ok(undefined);
			if (vault.state === 'locked') return VaultError.VaultLocked();
			for (const key of SECRET_KEYS) {
				const value = vault.get(key);
				if (value !== undefined) deviceConfig.set(key, value);
			}
			vault.destroy();
			refresh();
			return Ok(undefined);
		},

		/** Unlock the vault for this session. */
		async unlock(passphrase: string): Promise<Result<void, VaultError>> {
			await whenReady;
			const result = vault.unlock(passphrase);
			refresh();
			return result;
		},

		/** Drop the in-memory key; vault-stored secrets become unreadable until unlocked again. */
		async lock(): Promise<void> {
			await whenReady;
			vault.lock();
			refresh();
		},
	};
}

/**
 * The Whispering secrets singleton.
 *
 * The vault is its own Y.Doc and room (ADR 0005), persisted locally through
 * IndexedDB so `locked` vs `device-only` survives a reload. Relay sync (the
 * cross-device half) and desktop OS-keychain auto-unlock are later waves; this is
 * local-only for now. Mirrors `whispering.browser.ts`, which attaches
 * persistence at module load.
 */
const VAULT_DOC_GUID = 'epicenter-whispering-vault';
const vaultDoc = new Y.Doc({ guid: VAULT_DOC_GUID });
const vaultIdb = attachIndexedDb(vaultDoc);
const vault = createVault({ ydoc: vaultDoc, whenLoaded: vaultIdb.whenLoaded });
export const secrets = createSecrets({ vault });
