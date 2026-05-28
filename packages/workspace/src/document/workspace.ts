/**
 * `createWorkspace`: the canonical entry point for opening a workspace-backed
 * Y.Doc.
 *
 * Subsumes the three-line ritual every browser/daemon mount used to repeat:
 *
 * ```ts
 * const ydoc = new Y.Doc({ guid, gc: true });
 * const { tables, kv } = attachEncryption(ydoc, { keyring, tables, kv });
 * const actions = createXActions(tables);
 * ```
 *
 * becomes
 *
 * ```ts
 * using workspace = createWorkspace({ id, keyring, tables, kv });
 * const actions = createXActions(workspace);
 * ```
 *
 * ## Encrypted vs plaintext
 *
 * `keyring` is optional. When present, every table and the KV store activate
 * encryption derived from the owner keyring narrowed to `id` (one HKDF step,
 * shared across all stores in this workspace). When absent, stores are
 * constructed plaintext. One factory, both modes.
 *
 * The asymmetry is intentional: the encryption boundary is "does this
 * workspace participate in untrusted persistence (Cloud sync, encrypted
 * IndexedDB)?" Real user workspaces always pass a keyring because they
 * persist or sync. Tests, in-memory importers, and benchmarks omit it
 * because they live and die in-process and have no off-device data to
 * protect. There is no auto-generated "local keyring" for the no-keyring
 * path: that would silently invent a new key-recovery surface the caller
 * never opted into.
 *
 * ## Disposal
 *
 * `using workspace` triggers `ydoc.destroy()`, which cascades through every
 * store's `ydoc.once('destroy', ...)` hook. No standalone dispose surface.
 *
 * ## Identity
 *
 * `options.id` is the constructor input; `workspace.ydoc.guid` is the
 * canonical read. By construction they agree, and downstream code should read
 * `workspace.ydoc.guid` only.
 *
 * @module
 */

import type { Keyring } from '@epicenter/encryption';
import * as Y from 'yjs';
import { type ActionRegistry, defineActions } from '../shared/actions.js';
import { createEncryptedYkvLww } from '../shared/y-keyvalue/y-keyvalue-lww-encrypted.js';
import { deriveWorkspaceKeyring } from './derive-workspace-keyring.js';
import { KV_KEY, TableKey } from './keys.js';
import { createKv, type Kv, type KvDefinitions } from './kv.js';
import { createTable, type TableDefinitions, type Tables } from './table.js';
import {
	type ObservableKvStore,
	YKeyValueLww,
	type YKeyValueLwwEntry,
} from './y-keyvalue/index.js';

export type Workspace<
	TTables extends TableDefinitions,
	TKv extends KvDefinitions,
	TActions extends ActionRegistry = ActionRegistry,
> = {
	readonly ydoc: Y.Doc;
	readonly tables: Tables<TTables>;
	readonly kv: Kv<TKv>;
	readonly actions: TActions;
	[Symbol.dispose](): void;
};

/**
 * Type-check a live workspace bundle while preserving its exact inferred type.
 *
 * Use this when a runtime opener returns `{ ...workspace, ...runtimeExtras }`
 * and direct `satisfies Workspace<...>` would force the caller to restate table,
 * KV, action, or runtime generics that TypeScript can infer from the object.
 * Runtime behavior is identity: the same object is returned unchanged.
 */
export function defineWorkspace<
	TTables extends TableDefinitions,
	TKv extends KvDefinitions,
	TActions extends ActionRegistry,
	TWorkspace extends Workspace<TTables, TKv, TActions>,
>(workspace: TWorkspace): TWorkspace {
	return workspace;
}

export type CreateWorkspaceOptions<
	TTables extends TableDefinitions,
	TKv extends KvDefinitions,
> = {
	/**
	 * Stable workspace identifier. Stamped onto the Y.Doc as `guid`. Used as
	 * the HKDF domain-separation label when `keyring` is provided.
	 */
	id: string;

	/** Table definitions to materialize on the workspace root. */
	tables: TTables;

	/** KV definitions to materialize on the workspace root. Pass `{}` for none. */
	kv: TKv;

	/**
	 * Lazy reader for the current owner keyring. When provided, every table and
	 * the KV store activate encryption derived from this keyring narrowed to
	 * `id`. When absent, stores are constructed plaintext.
	 *
	 * Called synchronously at construction. Throw if no keyring is available
	 * (e.g. signed-out): a throw here means the caller built a workspace
	 * outside its signed-in scope, which is a bug.
	 */
	keyring?: () => Keyring;
};

/**
 * Build a fully wired workspace bundle:
 * `{ ydoc, tables, kv, actions, [Symbol.dispose] }`.
 *
 * The encrypted branch is the production path. It runs the same
 * construct, activate, hook-destroy sequence the deleted `attachEncryption`
 * primitive ran: one HKDF step over `keyring()` and `id`, then every
 * table and the KV slot are activated before any handle escapes. Lifting
 * that work into `createWorkspace` means the Y.Doc and its stores are
 * owned together (no temporal window where the doc exists but its stores
 * are not yet encrypted).
 *
 * Step by step:
 *   1. Construct `new Y.Doc({ guid: id, gc: true })`.
 *   2. If `keyring` is provided, derive the per-workspace HKDF keyring
 *      once. One derivation is reused for every store in this workspace
 *      (table stores and the KV slot) so an N-table workspace pays one
 *      HKDF cost, not N.
 *   3. For each table definition and for the KV slot: build a YKV store
 *      over `ydoc.getArray(...)`, hook `ydoc.once('destroy', dispose)`,
 *      and (encrypted mode only) call `activateEncryption(workspaceKeyring)`.
 *   4. Wrap with `createTable` / `createKv` for the typed surfaces.
 *   5. `[Symbol.dispose]()` calls `ydoc.destroy()`, which fires every
 *      registered destroy hook in turn.
 */
export function createWorkspace<
	TTables extends TableDefinitions,
	TKv extends KvDefinitions,
>(options: CreateWorkspaceOptions<TTables, TKv>): Workspace<TTables, TKv, {}> {
	const ydoc = new Y.Doc({
		guid: options.id,
		gc: true,
	});

	// One HKDF derivation per workspace, not per store. `null` selects
	// the plaintext branch in `attachStore`. See "Encrypted vs plaintext"
	// in the module doc for when that branch is intended.
	const workspaceKeyring = options.keyring
		? deriveWorkspaceKeyring(options.keyring(), options.id)
		: null;

	/**
	 * Build one store for a single workspace slot (one table, or the KV
	 * singleton). Two modes, selected by `workspaceKeyring`:
	 *
	 *   - Encrypted (`workspaceKeyring !== null`): the same
	 *     construct, hook-destroy, activate-encryption sequence the
	 *     deleted `attachEncryption` primitive ran. The store is
	 *     activated with the per-workspace keyring before it returns,
	 *     so no caller ever sees a not-yet-encrypted store.
	 *   - Plaintext (`workspaceKeyring === null`): bare YKV over a raw
	 *     `Y.Array`. Intended for in-memory importers, tests, and
	 *     benchmarks. Real user workspaces never take this branch.
	 *
	 * Both modes hook `ydoc.once('destroy', ...)` so a single
	 * `ydoc.destroy()` (triggered by `using` scope exit or an explicit
	 * `[Symbol.dispose]()`) cascades through every store.
	 */
	function attachStore(arrayKey: string): ObservableKvStore<unknown> {
		if (workspaceKeyring) {
			const store = createEncryptedYkvLww<unknown>(ydoc, arrayKey);
			ydoc.once('destroy', () => store[Symbol.dispose]());
			store.activateEncryption(workspaceKeyring);
			return store;
		}
		const yarray = ydoc.getArray<YKeyValueLwwEntry<unknown>>(arrayKey);
		const ykv = new YKeyValueLww<unknown>(yarray);
		ydoc.once('destroy', () => ykv[Symbol.dispose]());
		return ykv;
	}

	const tables = Object.fromEntries(
		Object.entries(options.tables).map(([name, definition]) => [
			name,
			createTable(attachStore(TableKey(name)), definition, name),
		]),
	) as Tables<TTables>;

	const kv = createKv(attachStore(KV_KEY), options.kv);

	return defineWorkspace({
		ydoc,
		tables,
		kv,
		actions: defineActions({}),
		[Symbol.dispose]() {
			ydoc.destroy();
		},
	});
}
