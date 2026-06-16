import { attachIndexedDb } from '@epicenter/workspace';
import { Ok, type Result } from 'wellcrafted/result';
import * as Y from 'yjs';
import { report } from '$lib/report';
import {
	deviceConfig,
	SECRET_KEYS,
	type SecretKey,
} from './device-config.svelte';
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
 *
 * Reads and writes are synchronous and reactive, gated by one boot await. The only
 * async step is hydrating the vault's IndexedDB to learn its state; that is a
 * one-time boot concern, not a per-read one (the underlying `vault.get` is a sync
 * in-memory decrypt). So the layout awaits {@link whenReady} once, exactly as it
 * already does for the main workspace, and after that every read is a synchronous,
 * reactive `SecretRead` that a `$derived` can consume (an async read could not
 * participate in Svelte's tracking scope, so the readiness UI could never react to
 * it). The cost of this shape is real and honest: the vault is a Y.Doc and must
 * hydrate, so a read taken before the gate sees the un-hydrated `absent` default
 * (the blank-key window ADR 0004 guards against). That is a wiring bug, not a
 * runtime state, so it fails loudly in dev rather than passing silently.
 */

/**
 * The keys the facade routes between the device and the vault, and the set it
 * migrates on sync enable/disable, are {@link SECRET_KEYS} — owned by the device
 * handle (ADR 0004: the device handle exposes its secret keys directly, no
 * registry). ADR 0004's secret-name guard test keeps account-synced KV from ever
 * matching one of these. `SecretKey` is re-exported for callers of this facade.
 */
export type { SecretKey };

/**
 * The outcome of reading a secret. `available` carries a non-empty value;
 * `locked` means the vault holds it but is not open; `missing` means no usable
 * value is stored in the current home. An unset key reads as `missing` from
 * either home (an empty device value is not a usable credential), so a caller
 * branches on status without caring which home answered.
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

export function createSecrets({ vault }: { vault: Vault }) {
	let vaultState = $state<VaultState>(vault.state);
	let isReady = $state(false);

	// Bumped on every vault change so a synchronous read re-runs reactively: a
	// value set locally now, or a value/metadata delivered over the relay later.
	// `vaultState` already covers lifecycle transitions (lock/unlock/provision);
	// this covers content. The subscription outlives the module singleton, which
	// is fine until the per-account lifecycle (ADR 0005) gives the vault a real
	// dispose.
	let revision = $state(0);
	vault.onChange(() => {
		revision += 1;
	});

	/** Mirror the vault's lifecycle into reactive state. Called after every transition. */
	function refresh(): void {
		vaultState = vault.state;
	}

	const whenReady = vault.whenReady.then(() => {
		refresh();
		isReady = true;
	});

	/**
	 * The boot gate, enforced loudly. Every read and write assumes the vault has
	 * hydrated; the layout awaits {@link whenReady} once before anything reads a
	 * secret. A call that beats the gate would read the un-hydrated `absent`
	 * default and could mis-home a secret (the blank-key window ADR 0004 guards
	 * against), so it is a wiring bug, not a runtime condition: surface it rather
	 * than letting it pass. It reports and returns rather than throwing, because a
	 * pre-gate device read is usually still correct (`localStorage` is sync); only
	 * a provisioned-vault read is wrong, and that is exactly what this flags.
	 */
	function reportIfNotReady(operation: string): void {
		if (isReady) return;
		report.error({
			title: 'Secret accessed before the vault was ready',
			cause: {
				name: 'SecretsReadBeforeReady',
				message: `secrets.${operation} ran before whenReady resolved; the boot gate (await secrets.whenReady at the layout) was skipped.`,
			},
		});
	}

	return {
		/** Reactive view of where secrets live, for the settings toggle. */
		get status(): SyncStatus {
			return toSyncStatus(vaultState);
		},

		/** Resolves once the vault has hydrated; await once at the layout boundary. */
		whenReady,

		/**
		 * Read a secret from its current home, synchronously and reactively. A
		 * `$derived` that calls this re-runs when the secret changes or the vault
		 * locks/unlocks. Returns `locked` when the vault owns the secret but is not
		 * open, so a caller prompts instead of using a blank key.
		 */
		get(key: SecretKey): SecretRead {
			reportIfNotReady('get');
			void revision; // register the reactive dependency on vault-doc changes
			if (vaultState === 'absent') {
				const value = deviceConfig.get(key);
				return value ? { status: 'available', value } : { status: 'missing' };
			}
			if (vaultState === 'locked') return { status: 'locked' };
			const value = vault.get(key);
			return value === undefined
				? { status: 'missing' }
				: { status: 'available', value };
		},

		/** Write a secret to its current home. Fails with `VaultLocked` while locked. */
		set(key: SecretKey, value: string): Result<void, VaultError> {
			reportIfNotReady('set');
			if (vaultState === 'absent') {
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
		enableSync(passphrase: string): Result<void, VaultError> {
			reportIfNotReady('enableSync');
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
		disableSync(): Result<void, VaultError> {
			reportIfNotReady('disableSync');
			if (vaultState === 'absent') return Ok(undefined);
			if (vaultState === 'locked') return VaultError.VaultLocked();
			for (const key of SECRET_KEYS) {
				const value = vault.get(key);
				if (value !== undefined) deviceConfig.set(key, value);
			}
			vault.destroy();
			refresh();
			return Ok(undefined);
		},

		/**
		 * Abandon the vault without the passphrase: the recovery path for a forgotten
		 * passphrase. Wipes this device's vault and returns to device-only, leaving
		 * the device secrets empty to regenerate. This is the "losing the passphrase
		 * loses the synced values" outcome ADR 0005 calls acceptable, made reachable;
		 * without it a `locked` vault no one can unlock is a dead end (`disableSync`
		 * needs unlocking to migrate, `unlock` rejects the wrong passphrase, `enableSync`
		 * is already provisioned).
		 *
		 * `forget` is local, not `disableSync`. `disableSync` is the graceful path that
		 * preserves keys by migrating them back; `forget` accepts their loss. When relay
		 * sync lands, `forget` must detach-and-wipe this device's local replica WITHOUT
		 * propagating CRDT deletes, so forgetting the passphrase on one device never
		 * destroys a sibling device's still-unlockable vault (ADR 0005). Local-only v1
		 * has no relay, so the local teardown below is already that detach.
		 */
		forget(): void {
			reportIfNotReady('forget');
			vault.destroy();
			refresh();
		},

		/** Unlock the vault for this session. */
		unlock(passphrase: string): Result<void, VaultError> {
			reportIfNotReady('unlock');
			const result = vault.unlock(passphrase);
			refresh();
			return result;
		},

		/** Drop the in-memory key; vault-stored secrets become unreadable until unlocked again. */
		lock(): void {
			reportIfNotReady('lock');
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
 *
 * Local-only placeholder: this guid is a fixed string and the persistence is the
 * raw, unscoped `attachIndexedDb`, matching whispering's main workspace, which is
 * not account-aware yet either. When whispering crosses the account-aware line,
 * the vault scopes to the signed-in owner via `attachLocalStorage(ydoc, { server,
 * ownerId })` (keying IndexedDB by `(server, ownerId, guid)`, mirroring the
 * relay's `/owners/:ownerId/rooms/:guid` partitioning) under the framework's
 * dispose-on-sign-out / remount-on-sign-in lifecycle. The guid stays a stable
 * per-app constant; the owner lives in the persistence layer, not the guid string.
 * See ADR 0005. Until then a fixed guid is correct: no auth, no relay, one
 * implicit local owner.
 */
const VAULT_DOC_GUID = 'epicenter-whispering-vault';
const vaultDoc = new Y.Doc({ guid: VAULT_DOC_GUID });
const vaultIdb = attachIndexedDb(vaultDoc);
const vault = createVault({ ydoc: vaultDoc, whenLoaded: vaultIdb.whenLoaded });
export const secrets = createSecrets({ vault });
