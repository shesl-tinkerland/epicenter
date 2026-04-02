/**
 * createWorkspace() — Instantiate a workspace client.
 *
 * Returns a client that IS usable directly AND has `.withExtension()` for chaining.
 *
 * ## Extension chaining vs action maps
 *
 * Extensions use chainable `.withExtension(key, factory)` because they build on each
 * other progressively — each factory receives previously added extensions as typed context.
 * You may be importing extensions you don't control and want to compose on top of them.
 *
 * Actions use a single `.withActions(factory)` because they don't build on each other,
 * are always defined by the app author, and benefit from being declared in one place.
 *
 * ## Unlock lifecycle
 *
 * `.withEncryption(config?)` opts the client into encryption. Without it,
 * `workspace.encryption` does not exist on the type.
 *
 * When configured, the full unlock pipeline is:
 * ```
 * workspace.encryption.unlock(userKey)
 *   → byte-level dedup against the active runtime key
 *   → deriveWorkspaceKey(userKey, workspaceId)  // sync HKDF
 *   → apply derived key to all encrypted stores
 *   → set runtime unlock state immediately
 *   → await userKeyStore.set(bytesToBase64(userKey)) if configured
 *
 * Auto-boot (when userKeyStore is provided):
 *   → whenReady: userKeyStore.get()
 *   → if cached key exists: workspace.encryption.unlock(cachedKey)
 *   → if unlock fails: userKeyStore.delete()
 *
 * workspace.encryption.lock()
 *   → clear key + deactivate all stores
 *
 * workspace.clearLocalData()
 *   → workspace.encryption.lock()
 *   → wipe persisted data (clearLocalData callbacks, LIFO)
 *   → await userKeyStore.delete() if configured
 * ```
 *
 * @example
 * ```typescript
 * // Direct use (no extensions)
 * const client = createWorkspace({ id: 'my-app', tables: { posts } });
 * client.tables.posts.set({ id: '1', title: 'Hello' });
 *
 * // With extensions (chained)
 * const client = createWorkspace({ id: 'my-app', tables: { posts } })
 *   .withExtension('persistence', indexeddbPersistence)
 *   .withExtension('sync', ySweetSync({ auth: directAuth('...') }));
 *
 * // With encryption + extensions
 * const client = createWorkspace({ id: 'my-app', tables: { posts } })
 *   .withEncryption({ userKeyStore })
 *   .withExtension('persistence', indexeddbPersistence)
 *   .withExtension('sync', createSyncExtension({ ... }));
 *
 * // With actions (terminal)
 * const client = createWorkspace({ id: 'my-app', tables: { posts } })
 *   .withExtension('persistence', indexeddbPersistence)
 *   .withActions((client) => ({
 *     createPost: defineMutation({ ... }),
 *   }));
 *
 * // From reusable definition
 * const def = defineWorkspace({ id: 'my-app', tables: { posts } });
 * const client = createWorkspace(def);
 * ```
 */

import * as Y from 'yjs';
import type { Actions } from '../shared/actions.js';
import {
	base64ToBytes,
	bytesToBase64,
	deriveWorkspaceKey,
} from '../shared/crypto/index.js';
import type { YKeyValueLwwEntry } from '../shared/y-keyvalue/y-keyvalue-lww.js';
import {
	createEncryptedYkvLww,
	type YKeyValueLwwEncrypted,
} from '../shared/y-keyvalue/y-keyvalue-lww-encrypted.js';
import { createAwareness } from './create-awareness.js';
import { createDocuments } from './create-document.js';
import { createKv } from './create-kv.js';
import { createTable } from './create-table.js';
import {
	defineExtension,
	disposeLifo,
	type MaybePromise,
	startDisposeLifo,
} from './lifecycle.js';
import type {
	AwarenessDefinitions,
	BaseRow,
	DocumentConfig,
	DocumentContext,
	DocumentExtensionRegistration,
	Documents,
	DocumentsHelper,
	EncryptionConfig,
	EncryptionKey,
	ExtensionContext,
	KvDefinitions,
	TableHelper,
	TablesHelper,
	TableDefinitions,
	WorkspaceClient,
	WorkspaceClientBuilder,
	WorkspaceDefinition,
	WorkspaceEncryption,
} from './types.js';
import { KV_KEY, TableKey } from './ydoc-keys.js';

/** Byte-level comparison for Uint8Array dedup. */
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
	return true;
}


/**
 * Create a workspace client with chainable extension support.
 *
 * The returned client IS directly usable (no extensions required) AND supports
 * chaining `.withExtension()` calls to progressively add extensions, each with
 * typed access to all previously added extensions.
 *
 * Single code path — no overloads, no branches. Awareness is always created
 * (like tables and KV). When no awareness fields are defined, the helper has
 * zero accessible field keys but `raw` is still available for sync providers.
 *
 * @param config - Workspace config (or WorkspaceDefinition from defineWorkspace())
 * @returns WorkspaceClientBuilder - a client that can be used directly or chained with .withExtension()
 */
export function createWorkspace<
	TId extends string,
	TTableDefinitions extends TableDefinitions = Record<string, never>,
	TKvDefinitions extends KvDefinitions = Record<string, never>,
	TAwarenessDefinitions extends AwarenessDefinitions = Record<string, never>,
>(
	{
		id,
		tables: tablesDef,
		kv: kvDef,
		awareness: awarenessDef,
	}: WorkspaceDefinition<
		TId,
		TTableDefinitions,
		TKvDefinitions,
		TAwarenessDefinitions
	>,
	options?: { key?: Uint8Array },
): WorkspaceClientBuilder<
	TId,
	TTableDefinitions,
	TKvDefinitions,
	TAwarenessDefinitions,
	Record<string, never>
> {
	// ── Data doc ────────────────────────────────────────────────────────
	const ydoc = new Y.Doc({ guid: id });

	const tableDefs = (tablesDef ?? {}) as TTableDefinitions;
	const kvDefs = (kvDef ?? {}) as TKvDefinitions;
	const awarenessDefs = (awarenessDef ?? {}) as TAwarenessDefinitions;

	// ── Tables ───────────────────────────────────────────────────────────────
	const tableEntries = Object.entries(tableDefs).map(([name, definition]) => {
		const yarray = ydoc.getArray<YKeyValueLwwEntry<unknown>>(TableKey(name));
		const store = createEncryptedYkvLww(yarray);
		const helper = createTable(store, definition);
		return { name, store, helper };
	});

	const tables = Object.fromEntries(
		tableEntries.map(({ name, helper }) => [name, helper]),
	) as TablesHelper<TTableDefinitions>;

	// ── KV ──────────────────────────────────────────────────────────────────
	const kvYarray = ydoc.getArray<YKeyValueLwwEntry<unknown>>(KV_KEY);
	const kvStore = createEncryptedYkvLww(kvYarray);
	const kvHelper = createKv(kvStore, kvDefs);

	// ── Encrypted stores (all table stores + KV store) ─────────────────────
	// The workspace owns this list so it can coordinate activateEncryption
	// and deactivateEncryption across all stores simultaneously.
	const encryptedStores: readonly YKeyValueLwwEncrypted<unknown>[] = [
		...tableEntries.map(({ store }) => store),
		kvStore,
	];

	// Seed encryption from construction-time key (if provided).
	// Equivalent to calling activateEncryption() immediately after creation.
	if (options?.key) {
		const keyring = new Map([[1, options.key]]);
		for (const store of encryptedStores) {
			store.activateEncryption(keyring);
		}
	}

	const awareness = createAwareness(ydoc, awarenessDefs);
	const definitions = {
		tables: tableDefs,
		kv: kvDefs,
		awareness: awarenessDefs,
	};

	/**
	 * Immutable builder state passed through the builder chain.
	 *
	 * Each `withExtension` creates new arrays instead of mutating shared state,
	 * which fixes builder branching isolation (two branches from the same base
	 * builder get independent extension sets).
	 *
	 * Three arrays track three distinct lifecycle moments:
	 * - `extensionCleanups` — `dispose()` shutdown: close connections, stop observers (irreversible)
	 * - `clearLocalDataCallbacks` — `workspace.clearLocalData()` data wipe: delete IndexedDB (reversible, repeatable)
	 * - `whenReadyPromises` — construction: composite `whenReady` waits for all extensions to init
	 */
	type BuilderState = {
		extensionCleanups: (() => MaybePromise<void>)[];
		clearLocalDataCallbacks: (() => MaybePromise<void>)[];
		whenReadyPromises: Promise<unknown>[];
	};

	type EncryptionRuntime = {
		encryption: WorkspaceEncryption;
		lock: () => void;
		clearCache: () => Promise<void>;
	};


	// Accumulated document extension registrations (in chain order).
	// Mutable array — grows as .withDocumentExtension() is called. Document
	// bindings reference this array by closure, so by the time user code
	// calls .open(), all extensions are registered.
	const documentExtensionRegistrations: DocumentExtensionRegistration[] = [];

	// Create documents for tables that have .withDocument() declarations.
	// Documents are created eagerly but reference documentExtensionRegistrations by closure,
	// so they pick up extensions added later via .withDocumentExtension().
	const documentCleanups: (() => Promise<void>)[] = [];
	// Runtime type is Record<string, Record<string, Documents<BaseRow>>> —
	// cast to DocumentsHelper at the end so it satisfies WorkspaceClient/ExtensionContext.
	const documentsNamespace: Record<
		string,
		Record<string, Documents<BaseRow>>
	> = {};

	for (const [tableName, tableDef] of Object.entries(tableDefs)) {
		if (Object.keys(tableDef.documents).length === 0) continue;

		const tableHelper = tables[tableName];
		if (!tableHelper) continue;

		const tableDocumentsNamespace: Record<string, Documents<BaseRow>> = {};

		for (const [docName, _documentConfig] of Object.entries(
			tableDef.documents,
		)) {
			const documentConfig = _documentConfig as DocumentConfig;
			const docTags: readonly string[] = documentConfig.tags ?? [];

			const documents = createDocuments({
				id,
				guidKey: documentConfig.guid as keyof BaseRow & string,
				onUpdate: documentConfig.onUpdate,
				tableHelper,
				ydoc,
				documentExtensions: documentExtensionRegistrations,
				documentTags: docTags,
			});

			tableDocumentsNamespace[docName] = documents;
			documentCleanups.push(() => documents.closeAll());
		}

		documentsNamespace[tableName] = tableDocumentsNamespace;
	}

	const typedDocuments =
		documentsNamespace as unknown as DocumentsHelper<TTableDefinitions>;

	/**
	 * Build a workspace client with the given extensions and lifecycle state.
	 *
	 * Called once at the bottom of `createWorkspace` (empty state), then once per
	 * `withExtension`/`withWorkspaceExtension` call (accumulated state). Each call
	 * returns a fresh builder object — the client object itself is shared across all
	 * builders (same `ydoc`, `tables`, `kv`), but the builder methods and extensions
	 * map are new.
	 */
	function buildClient<TExtensions extends Record<string, unknown>>({
		extensions,
		state,
		encryptionRuntime,
		actions,
	}: {
		extensions: TExtensions;
		state: BuilderState;
		encryptionRuntime?: EncryptionRuntime;
		actions: Actions;
	}): WorkspaceClientBuilder<
		TId,
		TTableDefinitions,
		TKvDefinitions,
		TAwarenessDefinitions,
		TExtensions
	> {
		const dispose = async (): Promise<void> => {
			// Close all documents first (before extensions they depend on)
			for (const cleanup of documentCleanups) {
				await cleanup();
			}
			const errors = await disposeLifo(state.extensionCleanups);
			awareness.raw.destroy();
			ydoc.destroy();

			if (errors.length > 0) {
				throw new Error(`Extension cleanup errors: ${errors.length}`);
			}
		};

		const whenReady = Promise.all(state.whenReadyPromises)
			.then(() => {})
			.catch(async (err) => {
				// If any extension's whenReady rejects, clean up everything
				await dispose().catch(() => {}); // idempotent
				throw err;
			});

		const client = {
			id,
			ydoc,
			definitions,
			tables,
			documents: typedDocuments,
			kv: kvHelper,
			awareness,
			// Each extension entry is the exports object stored by reference.
			extensions,
			actions,
			batch(fn: () => void): void {
				ydoc.transact(fn);
			},
			/**
			 * Apply a binary Y.js update to the underlying document.
			 *
			 * Use this to hydrate the workspace from a persisted snapshot (e.g. a `.yjs`
			 * file on disk) without exposing the raw Y.Doc to consumer code.
			 *
			 * @param update - A Uint8Array produced by `Y.encodeStateAsUpdate()` or equivalent
			 */
			loadSnapshot(update: Uint8Array): void {
				Y.applyUpdate(ydoc, update);
			},
			/**
			 * Get the encoded size of the current data doc in bytes.
			 *
			 * Useful for monitoring doc growth. This is the total
			 * CRDT state including history, not just the active data.
			 */
			encodedSize(): number {
				return Y.encodeStateAsUpdate(ydoc).byteLength;
			},
			async clearLocalData(): Promise<void> {
				encryptionRuntime?.lock();
				for (let i = state.clearLocalDataCallbacks.length - 1; i >= 0; i--) {
					try {
						await state.clearLocalDataCallbacks[i]?.();
					} catch (err) {
						console.error('Extension clearLocalData error:', err);
					}
				}
				await encryptionRuntime?.clearCache();
			},
			whenReady,
			dispose,
			[Symbol.asyncDispose]: dispose,
		};

		if (encryptionRuntime) {
			Object.assign(client, {
				encryption: encryptionRuntime.encryption,
				async unlockWithKeys(keys: EncryptionKey[]) {
					await whenReady;
					await encryptionRuntime.encryption.unlock(keys);
				},
			});
		}

		/**
		 * Apply an extension factory to the workspace Y.Doc.
		 *
		 * Shared by `withExtension` and `withWorkspaceExtension` — the only
		 * difference is whether `withExtension` also registers the factory for
		 * document Y.Docs (fired lazily at `documents.open()` time).
		 */
		function applyWorkspaceExtension<
			TKey extends string,
			TExports extends Record<string, unknown>,
		>(
			key: TKey,
			factory: (
				context: ExtensionContext<
					TId,
					TTableDefinitions,
					TKvDefinitions,
					TAwarenessDefinitions,
					TExtensions
				>,
			) => TExports & {
				whenReady?: Promise<unknown>;
				dispose?: () => MaybePromise<void>;
				clearLocalData?: () => MaybePromise<void>;
			},
		) {
			const {
				dispose: _dispose,
				[Symbol.asyncDispose]: _asyncDispose,
				whenReady: _whenReady,
				...clientContext
			} = client;
			const ctx = {
				...clientContext,
				whenReady:
					state.whenReadyPromises.length === 0
						? Promise.resolve()
						: Promise.all(state.whenReadyPromises).then(() => {}),
			};

			try {
				const raw = factory(ctx);

				// Void return means "not installed" — skip registration
				if (!raw)
					return buildClient({ extensions, state, encryptionRuntime, actions });

				const resolved = defineExtension(raw);

				return buildClient({
					extensions: {
						...extensions,
						[key]: resolved,
					} as TExtensions & Record<TKey, TExports>,
					state: {
						extensionCleanups: [...state.extensionCleanups, resolved.dispose],
						clearLocalDataCallbacks: [
							...state.clearLocalDataCallbacks,
							...(resolved.clearLocalData ? [resolved.clearLocalData] : []),
						],
						whenReadyPromises: [...state.whenReadyPromises, resolved.whenReady],
					},
					encryptionRuntime,
					actions,
				});
			} catch (err) {
				startDisposeLifo(state.extensionCleanups);
				throw err;
			}
		}

		// The builder methods use generics at the type level for progressive accumulation,
		// but the runtime implementations use wider types for storage (registrations array).
		// The cast at the end bridges the gap — type safety is enforced at call sites.
		const builder = Object.assign(client, {
			withExtension<
				TKey extends string,
				TExports extends Record<string, unknown>,
			>(
				key: TKey,
				factory: (context: {
					ydoc: Y.Doc;
					whenReady: Promise<void>;
				}) => TExports & {
					whenReady?: Promise<unknown>;
					dispose?: () => MaybePromise<void>;
					clearLocalData?: () => MaybePromise<void>;
				},
			) {
				// Registers for both workspace and document scopes.
				// The factory only receives SharedExtensionContext (ydoc + whenReady),
				// which is a structural subset of both ExtensionContext and DocumentContext.
				documentExtensionRegistrations.push({
					key,
					factory,
					tags: [],
				});
				return applyWorkspaceExtension(key, factory);
			},

			withWorkspaceExtension<
				TKey extends string,
				TExports extends Record<string, unknown>,
			>(
				key: TKey,
				factory: (
					context: ExtensionContext<
						TId,
						TTableDefinitions,
						TKvDefinitions,
						TAwarenessDefinitions,
						TExtensions
					>,
				) => TExports & {
					whenReady?: Promise<unknown>;
					dispose?: () => MaybePromise<void>;
					clearLocalData?: () => MaybePromise<void>;
				},
			) {
				return applyWorkspaceExtension(key, factory);
			},

			withDocumentExtension(
				key: string,
				factory: (context: DocumentContext) =>
					| (Record<string, unknown> & {
							whenReady?: Promise<unknown>;
							dispose?: () => MaybePromise<void>;
							clearLocalData?: () => MaybePromise<void>;
					  })
					| void,
				options?: { tags?: string[] },
			) {
				documentExtensionRegistrations.push({
					key,
					factory,
					tags: options?.tags ?? [],
				});
				return buildClient({ extensions, state, encryptionRuntime, actions });
			},

			withEncryption(config?: EncryptionConfig) {
				let activeUserKey: Uint8Array | undefined;
				let isActiveUserKeyCached = config?.userKeyStore === undefined;
				let workspaceKey: Uint8Array | undefined = options?.key;
				let cacheQueue = Promise.resolve();

				const runSerializedCacheTask = async (
					task: () => Promise<void>,
				): Promise<void> => {
					const next = cacheQueue.catch(() => {}).then(task);
					cacheQueue = next.catch(() => {});
					return await next;
				};

				const lock = () => {
					const previousKey = workspaceKey;
					const deactivated: YKeyValueLwwEncrypted<unknown>[] = [];
					try {
						for (const store of encryptedStores) {
							store.deactivateEncryption();
							deactivated.push(store);
						}
						activeUserKey = undefined;
						isActiveUserKeyCached = config?.userKeyStore === undefined;
						workspaceKey = undefined;
					} catch (error) {
						// Rollback: revert stores deactivated before the failure
						if (previousKey) {
							for (const store of deactivated) {
								try {
							store.activateEncryption(new Map([[1, previousKey]]));
								} catch { /* best-effort rollback */ }
							}
						}
						console.error('[workspace] Workspace lock failed:', error);
					}
				};

				const persistKeys = async (keys: EncryptionKey[]) => {
					if (!config?.userKeyStore) return;

					try {
						await runSerializedCacheTask(async () => {
							// Guard: only write if the active key still matches.
							// A rapid unlock(keysA) → unlock(keysB) sequence queues two
							// writes. By the time keysA's task runs, activeUserKey is
							// already keysB — skip the stale write entirely.
							if (
								activeUserKey === undefined ||
								!bytesEqual(activeUserKey, base64ToBytes(keys[0]!.userKeyBase64))
							)
								return;

							await config.userKeyStore.set(JSON.stringify(keys));
							isActiveUserKeyCached = true;
						});
					} catch (error) {
						console.error('[workspace] Encryption key cache save failed:', error);
					}
				};

				const unlock = async (keys: EncryptionKey[]) => {
					const currentUserKey = base64ToBytes(keys[0]!.userKeyBase64);
					const isSameUserKey =
						activeUserKey !== undefined && bytesEqual(activeUserKey, currentUserKey);

					if (!isSameUserKey) {
						// Build version → workspaceKey map from all keyring entries
						const workspaceKeyring = new Map<number, Uint8Array>();
						for (const { version, userKeyBase64 } of keys) {
							workspaceKeyring.set(
								version,
								deriveWorkspaceKey(base64ToBytes(userKeyBase64), id),
							);
						}
						const previousWorkspaceKey = workspaceKey;
						const nextWorkspaceKey = workspaceKeyring.get(
							Math.max(...workspaceKeyring.keys()),
						)!;
						const activated: YKeyValueLwwEncrypted<unknown>[] = [];
						try {
							for (const store of encryptedStores) {
								store.activateEncryption(workspaceKeyring);
								activated.push(store);
							}
							workspaceKey = nextWorkspaceKey;
							activeUserKey = currentUserKey;
							isActiveUserKeyCached = config?.userKeyStore === undefined;
						} catch (error) {
							// Rollback: revert stores activated before the failure
							for (const store of activated) {
								try {
									if (previousWorkspaceKey) {
										store.activateEncryption(new Map([[1, previousWorkspaceKey]]));
									} else {
										store.deactivateEncryption();
									}
								} catch { /* best-effort rollback */ }
							}
							console.error('[workspace] Workspace unlock failed:', error);
							return;
						}
					}

					if (config?.userKeyStore && !isActiveUserKeyCached) {
						await persistKeys(keys);
					}
				};

				const clearCache = async () => {
					if (!config?.userKeyStore) return;
					await runSerializedCacheTask(async () => {
						await config.userKeyStore.delete();
					});
				};

				const baseEncryption: WorkspaceEncryption = {
					get isUnlocked() {
						return workspaceKey !== undefined;
					},
					unlock,
					lock,
				};

				// Auto-boot: if a key store is provided, attempt unlock from store
				// after all extensions are ready. Passing userKeyStore implies auto-boot.
				if (config?.userKeyStore) {
					const store = config.userKeyStore;
					state.whenReadyPromises.push(
						Promise.all(state.whenReadyPromises).then(async () => {
							const cached = await store.get();
							if (!cached) return;
							try {
								const keys = JSON.parse(cached) as EncryptionKey[];
								await unlock(keys);
							} catch (error) {
								console.error('[workspace] Cached key unlock failed:', error);
								await clearCache();
							}
						}),
					);
				}

				const encryptionRuntime: EncryptionRuntime = {
					encryption: baseEncryption,
					lock,
					clearCache,
				};

				return buildClient({
					extensions,
					state,
					encryptionRuntime,
					actions,
				}) as unknown as WorkspaceClientBuilder<
					TId,
					TTableDefinitions,
					TKvDefinitions,
					TAwarenessDefinitions,
					TExtensions,
					Record<string, never>,
					{
						encryption: typeof encryptionRuntime.encryption;
					}
				>;
			},

			withActions(
				factory: (
					client: WorkspaceClient<
						TId,
						TTableDefinitions,
						TKvDefinitions,
						TAwarenessDefinitions,
						TExtensions
					>,
				) => Actions,
			) {
				const newActions = factory(client);
				return buildClient({
					extensions,
					state,
					encryptionRuntime,
					actions: { ...actions, ...newActions },
				});
			},
		});

		return builder as unknown as WorkspaceClientBuilder<
			TId,
			TTableDefinitions,
			TKvDefinitions,
			TAwarenessDefinitions,
			TExtensions
		>;
	}

	return buildClient({
		extensions: {} as Record<string, never>,
		state: {
			extensionCleanups: [],
			clearLocalDataCallbacks: [],
			whenReadyPromises: [],
		},
		actions: {},
	});
}

export type { WorkspaceClient, WorkspaceClientBuilder };
