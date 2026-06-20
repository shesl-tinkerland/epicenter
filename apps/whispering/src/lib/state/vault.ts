import {
	type Argon2Params,
	createVaultKeyring,
	PRODUCTION_ARGON2_PARAMS,
	unlockVaultKeyring,
	VaultMetadata,
} from '@epicenter/encryption';
import { createEncryptedYkvLww } from '@epicenter/workspace/shared/y-keyvalue/y-keyvalue-lww-encrypted';
import { type } from 'arktype';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';
import type * as Y from 'yjs';

/**
 * The vault: a passphrase-locked, end-to-end-encrypted credential store
 * (ADR 0042). Pure crypto and lock lifecycle. It knows nothing about the device
 * handle, about which secrets are provider keys, or about the UI. That routing
 * lives one layer up in `secrets.svelte.ts`; the vault is just the encrypted box.
 *
 * Keeping this layer free of Svelte runes is deliberate: it makes the state
 * machine a plain synchronous object that unit-tests against a bare `Y.Doc`. The
 * reactive mirror that the UI reads is the facade's job.
 *
 * ## States
 *
 * ```txt
 *  absent ──provision──► unlocked ◄──unlock── locked
 *    ▲                      │  │                 ▲
 *    └──── destroy ─────────┘  └──── lock ───────┘
 * ```
 *
 * - `absent`: never provisioned. No metadata, no key. (The facade presents this
 *   as "secrets live on the device".)
 * - `locked`: provisioned (its wrapped key and salt are persisted and sync), but
 *   the master key is not in memory this session. Ciphertext still syncs; it
 *   cannot be read or written here.
 * - `unlocked`: the master key is in memory. `get`/`set` decrypt and encrypt.
 *
 * ## Readiness, not a state
 *
 * The vault's metadata hydrates asynchronously (IndexedDB now, the relay later),
 * so the initial `state` is meaningless until {@link Vault.whenReady} resolves.
 * Every method assumes a settled state; the facade awaits `whenReady` once and
 * then drives the vault synchronously, so a half-loaded read never escapes. A
 * direct caller must do the same.
 *
 * ## Why the key is memory-only
 *
 * The unwrapped master key lives only inside the encrypted store's in-memory
 * encryption state. Only the *wrapped* key (ciphertext) is persisted, as
 * plaintext metadata. `lock`, `destroy`, and reload all drop the live key by
 * disposing and recreating the store in passthrough mode. Desktop OS-keychain
 * auto-unlock is a later wave and deliberately absent.
 */

/** Y.Array name for the encrypted secret values. */
const SECRETS_NAMESPACE = 'secrets';
/** Y.Map name for the plaintext vault metadata (salt, Argon2id params, wrapped master key). */
const METADATA_MAP = 'vault';
/** Key under {@link METADATA_MAP} holding the single {@link VaultMetadata} record. */
const METADATA_KEY = 'metadata';

export const VaultError = defineErrors({
	VaultAlreadyProvisioned: () => ({
		message: 'The vault is already set up. Unlock it instead.',
	}),
	VaultNotProvisioned: () => ({
		message: 'No vault has been set up yet.',
	}),
	WrongPassphrase: () => ({
		message: "That passphrase didn't unlock the vault.",
	}),
	VaultLocked: () => ({
		message: 'Unlock the vault before reading or writing secrets.',
	}),
});
export type VaultError = InferErrors<typeof VaultError>;

/** The lock lifecycle. Meaningful only once {@link Vault.whenReady} has resolved. */
export type VaultState = 'absent' | 'locked' | 'unlocked';

export type Vault = ReturnType<typeof createVault>;

export function createVault({
	ydoc,
	whenLoaded,
	argon2Params = PRODUCTION_ARGON2_PARAMS,
}: {
	ydoc: Y.Doc;
	whenLoaded: Promise<unknown>;
	/**
	 * Argon2id cost for provisioning. Defaults to the production floor; stored in
	 * the vault metadata so a later cost bump can re-derive. Tunable per the spec,
	 * and tests pass cheap parameters to stay fast. Unlock reads the params back
	 * from metadata, so it is not configured here.
	 */
	argon2Params?: Argon2Params;
}) {
	const metaMap = ydoc.getMap<unknown>(METADATA_MAP);

	/**
	 * The encrypted store. Passthrough until `provision`/`unlock` activate it with
	 * the master key; `lock`/`destroy` dispose and recreate it to drop the key.
	 */
	let secrets = createEncryptedYkvLww<string>(ydoc, SECRETS_NAMESPACE);

	let state: VaultState = 'absent';

	/** The persisted/synced metadata, or `null` when no vault exists. */
	function readMetadata(): VaultMetadata | null {
		const validated = VaultMetadata(metaMap.get(METADATA_KEY));
		return validated instanceof type.errors ? null : validated;
	}

	/** Drop the in-memory key by disposing the active store and starting a fresh passthrough one. */
	function dropKey(): void {
		secrets[Symbol.dispose]();
		secrets = createEncryptedYkvLww<string>(ydoc, SECRETS_NAMESPACE);
	}

	// Settle the initial state from persisted metadata: a provisioned vault loads
	// as `locked` (the key was never persisted), an unprovisioned one as `absent`.
	const whenReady = whenLoaded.then(() => {
		state = readMetadata() ? 'locked' : 'absent';
	});

	return {
		get state(): VaultState {
			return state;
		},

		/** Resolves once metadata has hydrated and {@link state} is meaningful. */
		whenReady,

		/**
		 * Subscribe to vault changes: fires on any update to the underlying doc (a
		 * value written here, or one delivered over the relay later). Lets the
		 * reactive facade invalidate its synchronous reads without reaching into the
		 * doc itself, keeping the doc encapsulated here. Returns an unsubscribe.
		 */
		onChange(listener: () => void): () => void {
			ydoc.on('update', listener);
			return () => ydoc.off('update', listener);
		},

		/**
		 * Provision a brand-new vault from a passphrase and unlock it. Generates the
		 * master key, persists its wrapped form as plaintext metadata, and goes to
		 * `unlocked`. The passphrase is taken as-is: gate weak ones at the call site.
		 */
		provision(passphrase: string): Result<void, VaultError> {
			if (state !== 'absent') return VaultError.VaultAlreadyProvisioned();
			const { metadata, keyring } = createVaultKeyring(passphrase, {
				params: argon2Params,
			});
			metaMap.set(METADATA_KEY, metadata);
			secrets.activateEncryption(keyring);
			state = 'unlocked';
			return Ok(undefined);
		},

		/**
		 * Unlock an existing vault by re-deriving the master key from the passphrase
		 * and the synced metadata. A wrong passphrase is a normal outcome, returned
		 * as `WrongPassphrase` rather than thrown.
		 */
		unlock(passphrase: string): Result<void, VaultError> {
			if (state === 'absent') return VaultError.VaultNotProvisioned();
			if (state === 'unlocked') return Ok(undefined);
			const metadata = readMetadata();
			if (!metadata) return VaultError.VaultNotProvisioned();
			const keyring = unlockVaultKeyring(passphrase, metadata);
			if (!keyring) return VaultError.WrongPassphrase();
			secrets.activateEncryption(keyring);
			state = 'unlocked';
			return Ok(undefined);
		},

		/** Drop the in-memory key and return to `locked`. A no-op unless unlocked. */
		lock(): void {
			if (state !== 'unlocked') return;
			dropKey();
			state = 'locked';
		},

		/** Tear the vault down to `absent`: drop the key and clear metadata and values. */
		destroy(): void {
			if (state === 'absent') return;
			ydoc.transact(() => {
				secrets.bulkDelete([...secrets.reads()].map(([key]) => key));
				metaMap.delete(METADATA_KEY);
			});
			dropKey();
			state = 'absent';
		},

		/** Decrypt a stored secret. `undefined` when unset or not unlocked. */
		get(key: string): string | undefined {
			return state === 'unlocked' ? secrets.get(key) : undefined;
		},

		/** Encrypt and store a secret. Fails with `VaultLocked` unless unlocked. */
		set(key: string, value: string): Result<void, VaultError> {
			if (state !== 'unlocked') return VaultError.VaultLocked();
			secrets.set(key, value);
			return Ok(undefined);
		},
	};
}
