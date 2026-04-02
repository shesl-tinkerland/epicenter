/**
 * Encryption runtime — manages lock/unlock state, key derivation, and cache lifecycle.
 *
 * Extracted from `create-workspace.ts` so encryption logic is independently testable
 * and its dependencies are explicit (no closures over workspace internals).
 *
 * The workspace builder calls `createEncryptionRuntime()` inside `withEncryption()`
 * and wires the returned object into the builder's lifecycle state.
 *
 * @module
 */

import { type } from 'arktype';
import { base64ToBytes, deriveWorkspaceKey } from '../shared/crypto/index.js';
import type { YKeyValueLwwEncrypted } from '../shared/y-keyvalue/y-keyvalue-lww-encrypted.js';
import { EncryptionKeys as EncryptionKeysSchema } from './encryption-key.js';
import type { EncryptionKeys, WorkspaceEncryption } from './types.js';
import type { EncryptionKeysJson, UserKeyStore } from './user-key-store.js';

// ════════════════════════════════════════════════════════════════════════════
// HELPERS — Only used by encryption operations
// ════════════════════════════════════════════════════════════════════════════

/** Byte-level comparison for Uint8Array dedup. */
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
	return true;
}

/**
 * Apply an operation to every encrypted store with automatic rollback on partial failure.
 *
 * If any store throws during `apply`, all previously applied stores are reverted
 * via `rollback` (best-effort). The original error is re-thrown so the caller
 * can handle it (log, return early, etc.).
 */
function transactStores(
	stores: readonly YKeyValueLwwEncrypted<unknown>[],
	apply: (store: YKeyValueLwwEncrypted<unknown>) => void,
	rollback: (store: YKeyValueLwwEncrypted<unknown>) => void,
): void {
	const applied: YKeyValueLwwEncrypted<unknown>[] = [];
	try {
		for (const store of stores) {
			apply(store);
			applied.push(store);
		}
	} catch (error) {
		for (const store of applied) {
			try {
				rollback(store);
			} catch {
				/* best-effort */
			}
		}
		throw error;
	}
}

// ════════════════════════════════════════════════════════════════════════════
// ENCRYPTION RUNTIME
// ════════════════════════════════════════════════════════════════════════════

/**
 * Create an encryption runtime with explicit dependencies.
 *
 * Manages all encryption state: locked/unlocked transitions, HKDF key derivation,
 * transactional store activation, cache serialization, and auto-boot from cached keys.
 *
 * The returned object is consumed by the workspace builder:
 * - `encryption` is exposed on the client as `workspace.encryption`
 * - `lock` and `clearCache` are called by `workspace.clearLocalData()`
 * - `bootPromise` (when present) is wired into the builder's `whenReadyPromises`
 *
 * @param config.workspaceId - Used for per-workspace HKDF key derivation
 * @param config.stores - All encrypted stores (tables + KV) to activate/deactivate
 * @param config.userKeyStore - Optional cache for auto-boot on startup
 */
export function createEncryptionRuntime(config: {
	workspaceId: string;
	stores: readonly YKeyValueLwwEncrypted<unknown>[];
	userKeyStore?: UserKeyStore;
}): {
	encryption: WorkspaceEncryption;
	lock: () => void;
	clearCache: () => Promise<void>;
	bootPromise?: Promise<void>;
} {
	const { workspaceId, stores, userKeyStore } = config;

	// ── State ────────────────────────────────────────────────────────────
	// encryptionState: the core locked/unlocked state (undefined = locked)
	// persisted: whether the active key has been written to the cache
	// cacheQueue: serializes async cache operations to prevent write races
	let encryptionState:
		| {
				userKey: Uint8Array;
				keyring: ReadonlyMap<number, Uint8Array>;
		  }
		| undefined;
	let persisted = !userKeyStore;
	let cacheQueue = Promise.resolve();

	const runSerializedCacheTask = async (
		task: () => Promise<void>,
	): Promise<void> => {
		const next = cacheQueue.catch(() => {}).then(task);
		cacheQueue = next.catch(() => {});
		return await next;
	};

	// ── Operations ───────────────────────────────────────────────────────

	const lock = () => {
		const previous = encryptionState;
		try {
			transactStores(
				stores,
				(s) => s.deactivateEncryption(),
				(s) => {
					if (previous) s.activateEncryption(previous.keyring);
				},
			);
		} catch (error) {
			console.error('[workspace] Workspace lock failed:', error);
			throw error;
		}
		encryptionState = undefined;
		persisted = !userKeyStore;
	};

	const persistKeys = async (
		keys: EncryptionKeys,
		currentUserKey: Uint8Array,
	) => {
		if (!userKeyStore) return;
		try {
			await runSerializedCacheTask(async () => {
				// Guard: skip stale writes from earlier unlock() calls
				if (
					!encryptionState ||
					!bytesEqual(encryptionState.userKey, currentUserKey)
				)
					return;
				await userKeyStore.set(JSON.stringify(keys) as EncryptionKeysJson);
				persisted = true;
			});
		} catch (error) {
			console.error('[workspace] Encryption key cache save failed:', error);
		}
	};

	const unlock = async (keys: EncryptionKeys) => {
		const decoded = keys.map((k) => ({
			version: k.version,
			userKey: base64ToBytes(k.userKeyBase64),
		}));
		const current = decoded.reduce((a, b) => (a.version > b.version ? a : b));

		// De-dup: same user key → skip re-derivation, just persist if needed
		if (
			encryptionState &&
			bytesEqual(encryptionState.userKey, current.userKey)
		) {
			if (!persisted) await persistKeys(keys, current.userKey);
			return;
		}

		// Derive workspace keyring from all key versions
		const keyring = new Map<number, Uint8Array>();
		for (const { version, userKey } of decoded) {
			keyring.set(version, deriveWorkspaceKey(userKey, workspaceId));
		}

		// Activate all stores (automatic rollback on partial failure)
		const previous = encryptionState;
		try {
			transactStores(
				stores,
				(s) => s.activateEncryption(keyring),
				(s) =>
					previous
						? s.activateEncryption(previous.keyring)
						: s.deactivateEncryption(),
			);
		} catch (error) {
			console.error('[workspace] Workspace unlock failed:', error);
			throw error;
		}

		// Atomic state transition — one assignment, not three
		encryptionState = { userKey: current.userKey, keyring };
		persisted = !userKeyStore;

		if (!persisted) await persistKeys(keys, current.userKey);
	};

	const clearCache = async () => {
		if (!userKeyStore) return;
		await runSerializedCacheTask(async () => {
			await userKeyStore.delete();
		});
	};

	const bootFromCache = async () => {
		if (!userKeyStore) return;
		const cached = await userKeyStore.get();
		if (!cached) return;
		try {
			const parsed = EncryptionKeysSchema(JSON.parse(cached));
			if (parsed instanceof type.errors) {
				console.error(
					'[workspace] Cached encryption keys invalid:',
					parsed.summary,
				);
				await clearCache();
				return;
			}
			await unlock(parsed);
		} catch (error) {
			console.error('[workspace] Cached key unlock failed:', error);
			await clearCache();
		}
	};

	// ── Assemble ─────────────────────────────────────────────────────────

	const encryption: WorkspaceEncryption = {
		get isUnlocked() {
			return encryptionState !== undefined;
		},
		unlock,
		lock,
	};

	const bootPromise = userKeyStore ? bootFromCache() : undefined;

	return { encryption, lock, clearCache, bootPromise };
}
