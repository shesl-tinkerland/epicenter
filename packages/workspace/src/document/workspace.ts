/**
 * Workspace definitions and root Y.Doc construction.
 *
 * `defineWorkspace({ id, tables, kv })` is the app-facing entry point.
 * `.create()` builds the bare root for daemon composition; `.connect(connection)`
 * connects it for the browser with local storage, sync, wipe, and row child-doc
 * openers.
 *
 * `createWorkspace({ id, tables, kv })` remains the low-level root constructor
 * for package internals and tests:
 *
 * ```ts
 * using workspace = createWorkspace({ id, tables, kv });
 * ```
 *
 * ## Storage
 *
 * Every table and the KV store are constructed as plaintext Yjs-backed
 * stores. The relay is trusted, so `createWorkspace` no longer derives or
 * activates client-side encryption keys.
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

import { InstantString } from '@epicenter/field';
import * as Y from 'yjs';
import { createDisposableCache } from '../cache/disposable-cache.js';
import { type ActionRegistry, defineActions } from '../shared/actions.js';
import type { Guid } from '../shared/id.js';
import { once } from '../shared/once.js';
import { assertSafeSegment } from '../shared/safe-segment.js';
import { type ConnectionConfig, connectDoc } from './connect-doc.js';
import { docGuid } from './doc-guid.js';
import { KV_KEY, TableKey } from './keys.js';
import { createKv, type Kv, type KvDefinitions } from './kv.js';
import { onLocalUpdate } from './on-local-update.js';
import type { Collaboration } from './open-collaboration.js';
import {
	type ChildDocDeclaration,
	type ChildDocDeclarations,
	createTable,
	type InferTableRow,
	type LayoutOf,
	type TableDefinition,
	type TableDefinitions,
	type Tables,
} from './table.js';
import { wipeLocalStorage } from './wipe-local-storage.js';
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
	readonly tables: WorkspaceTables<TTables>;
	readonly kv: Kv<TKv>;
	readonly actions: TActions;
	[Symbol.dispose](): void;
};

/**
 * `satisfies Workspace<...>` as a function: type-check a live workspace bundle
 * while preserving its exact inferred type.
 *
 * Use this when a runtime opener returns `{ ...workspace, ...runtimeExtras }`
 * and direct `satisfies Workspace<...>` would force the caller to restate table,
 * KV, action, or runtime generics that TypeScript can infer from the object.
 * Runtime behavior is identity: the same object is returned unchanged.
 */
export function satisfiesWorkspace<
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
	 * Stable workspace identifier. Stamped onto the Y.Doc as `guid`.
	 */
	id: string;

	/** Table definitions to materialize on the workspace root. */
	tables: TTables;

	/** KV definitions to materialize on the workspace root. Pass `{}` for none. */
	kv: TKv;
};

export type WorkspaceActionContext<
	TTables extends TableDefinitions,
	TKv extends KvDefinitions,
> = {
	readonly ydoc: Y.Doc;
	/**
	 * The root table handles, each carrying its `.docs.<field>.guid(rowId)`
	 * deriver. Action handlers close over the same guid-owning table path the
	 * rest of the workspace uses, so an action never re-derives a child-doc guid
	 * by hand. No `open`: actions run before any connection, so only the pure
	 * guid half is reachable here (the connected opener is layered later).
	 */
	readonly tables: WorkspaceTables<TTables>;
	readonly kv: Kv<TKv>;
};

export type DefineWorkspaceOptions<
	TTables extends TableDefinitions,
	TKv extends KvDefinitions,
	TActions extends ActionRegistry,
> = CreateWorkspaceOptions<TTables, TKv> & {
	/**
	 * Build the action registry after tables and KV are live, so handlers can
	 * close over the handles they query or mutate.
	 */
	actions?: (workspace: WorkspaceActionContext<TTables, TKv>) => TActions;
};

type ChildDocHandle<TLayout extends (ydoc: Y.Doc) => object> =
	ReturnType<TLayout> & {
		readonly ydoc: Y.Doc;
		readonly guid: Guid;
		readonly whenLoaded: Promise<unknown>;
		[Symbol.dispose](): void;
	};

/**
 * The guid-only entry every `.docs.<field>` exposes: derive a row's child-doc
 * guid without a connection. Pure (workspace id + table + row id + field), so it
 * is available on the unconnected root too, and a daemon reading one body over
 * HTTP derives the same guid the browser opener uses.
 */
type RowDocGuid<TRowId extends string> = {
	guid(rowId: TRowId): Guid;
};

type RowChildDocCache<
	TRowId extends string,
	TLayout extends (ydoc: Y.Doc) => object,
> = RowDocGuid<TRowId> & {
	open(rowId: TRowId): ChildDocHandle<TLayout>;
};

/**
 * The guid-only `.docs` namespace present on every table handle, connected or
 * not. `{}` for a table that declared no child docs.
 */
type TableDocGuids<TTableDefinition extends TableDefinition<any, any>> =
	TTableDefinition extends TableDefinition<
		any,
		infer TDecls extends ChildDocDeclarations
	>
		? {
				[K in keyof TDecls]: RowDocGuid<InferTableRow<TTableDefinition>['id']>;
			}
		: {};

/**
 * The `.docs` namespace a connected table handle gains: one row child-doc cache
 * per declared layout, keyed by field name. Each entry adds `open(rowId)` to the
 * field's existing guid deriver. Lives one level below the table's CRUD methods,
 * so field names never collide with `set`, `open`, etc. Empty `{}` for a table
 * that declared no child docs. Teardown is owned by the workspace, not the
 * field: every cache cascades off the root `ydoc.destroy()`.
 */
type TableDocs<TTableDefinition extends TableDefinition<any, any>> =
	TTableDefinition extends TableDefinition<
		any,
		infer TDecls extends ChildDocDeclarations
	>
		? {
				[K in keyof TDecls]: RowChildDocCache<
					InferTableRow<TTableDefinition>['id'],
					LayoutOf<TDecls[K]>
				>;
			}
		: {};

/**
 * The root table map: each table handle plus its guid-only `.docs` namespace.
 * `defineWorkspace(...).connect(connection)` upgrades each `.docs.<field>` with
 * an `open(rowId)` opener (see {@link ConnectedTables}).
 */
export type WorkspaceTables<TTableDefinitions extends TableDefinitions> = {
	[K in keyof TTableDefinitions]: Tables<TTableDefinitions>[K] & {
		readonly docs: TableDocGuids<TTableDefinitions[K]>;
	};
};

export type ConnectedTables<TTableDefinitions extends TableDefinitions> = {
	[K in keyof TTableDefinitions]: Tables<TTableDefinitions>[K] & {
		readonly docs: TableDocs<TTableDefinitions[K]>;
	};
};

/**
 * What a runtime `compose` callback sees: the connected workspace before its
 * infrastructure is soldered on. This is the one place `tables` is retyped from
 * guid-only ({@link WorkspaceTables}) to connected ({@link ConnectedTables}), so
 * every richer connected type builds additively on top of it instead of
 * re-omitting `tables` again.
 */
export type ConnectedWorkspaceContext<
	TTables extends TableDefinitions,
	TKv extends KvDefinitions,
	TActions extends ActionRegistry = ActionRegistry,
> = Omit<Workspace<TTables, TKv, TActions>, 'tables'> & {
	readonly tables: ConnectedTables<TTables>;
};

/**
 * The browser-connected workspace `connect()` returns: the connected context
 * plus its soldered-on infrastructure (local IndexedDB persistence, the
 * collaboration relay, and `wipe()`). Defined as `context + infra` to mirror
 * what `connect()` does at runtime: take the context, bolt on the connection
 * handles.
 */
export type ConnectedWorkspace<
	TTables extends TableDefinitions,
	TKv extends KvDefinitions,
	TActions extends ActionRegistry = ActionRegistry,
> = ConnectedWorkspaceContext<TTables, TKv, TActions> & {
	readonly idb: ReturnType<typeof connectDoc>['idb'];
	readonly collaboration: Collaboration<TActions>;
	wipe(): Promise<void>;
};

/**
 * What a `connect(connection, compose)` runtime builder returns: the final action
 * registry plus any runtime-only handles the app wants on the bundle.
 *
 * `actions` is required, not optional: a runtime builder is exactly where
 * browser-only actions get layered onto the base registry, and that returned
 * registry is the one collaboration serves for cross-node dispatch. Returning
 * `{ actions: workspace.actions }` (the base, unchanged) is the explicit way to
 * say "no new actions" — there is no implicit fallback to guess at.
 */
export type WorkspaceRuntimeExtension<
	TActions extends ActionRegistry = ActionRegistry,
> = {
	readonly actions: TActions;
	[Symbol.dispose]?(): void;
};

type ConnectedWorkspaceWithRuntime<
	TTables extends TableDefinitions,
	TKv extends KvDefinitions,
	TRuntime extends WorkspaceRuntimeExtension,
> = ConnectedWorkspace<TTables, TKv, TRuntime['actions']> &
	Omit<TRuntime, 'actions' | typeof Symbol.dispose>;

export type WorkspaceDefinition<
	TTables extends TableDefinitions,
	TKv extends KvDefinitions,
	TActions extends ActionRegistry = ActionRegistry,
> = {
	readonly id: string;
	readonly tables: TTables;
	readonly kv: TKv;
	create(): Workspace<TTables, TKv, TActions>;
	connect(
		connection: ConnectionConfig,
	): ConnectedWorkspace<TTables, TKv, TActions>;
	connect<TRuntime extends WorkspaceRuntimeExtension>(
		connection: ConnectionConfig,
		compose: (
			workspace: ConnectedWorkspaceContext<TTables, TKv, TActions>,
		) => TRuntime,
	): ConnectedWorkspaceWithRuntime<TTables, TKv, TRuntime>;
};

/** The unconnected root workspace returned by `definition.create()`. */
export type WorkspaceFromDefinition<TDefinition> =
	TDefinition extends WorkspaceDefinition<
		infer TTables,
		infer TKv,
		infer TActions
	>
		? Workspace<TTables, TKv, TActions>
		: never;

/**
 * Build a fully wired workspace bundle:
 * `{ ydoc, tables, kv, actions, [Symbol.dispose] }`.
 *
 * Step by step:
 *   1. Construct `new Y.Doc({ guid: id, gc: true })`.
 *   2. For each table definition and for the KV slot: build a YKV store
 *      over `ydoc.getArray(...)`, hook `ydoc.once('destroy', dispose)`,
 *      and return the bare plaintext store.
 *   3. Wrap with `createTable` / `createKv` for the typed surfaces.
 *   4. `[Symbol.dispose]()` calls `ydoc.destroy()`, which fires every
 *      registered destroy hook in turn.
 */
export function createWorkspace<
	TTables extends TableDefinitions,
	TKv extends KvDefinitions,
>(options: CreateWorkspaceOptions<TTables, TKv>): Workspace<TTables, TKv, {}> {
	assertSafeSegment(options.id, 'workspace id');
	const ydoc = new Y.Doc({
		guid: options.id,
		gc: true,
	});

	/**
	 * Build one store for a single workspace slot (one table, or the KV
	 * singleton). Each store is a bare YKV over a raw `Y.Array`.
	 *
	 * Every store hooks `ydoc.once('destroy', ...)` so a single `ydoc.destroy()`
	 * (triggered by `using` scope exit or an explicit
	 * `[Symbol.dispose]()`) cascades through every store.
	 */
	function attachStore(arrayKey: string): ObservableKvStore<unknown> {
		const yarray = ydoc.getArray<YKeyValueLwwEntry<unknown>>(arrayKey);
		const ykv = new YKeyValueLww<unknown>(yarray);
		ydoc.once('destroy', () => ykv[Symbol.dispose]());
		return ykv;
	}

	const tables = Object.fromEntries(
		Object.entries(options.tables).map(([name, definition]) => {
			const table = createTable(attachStore(TableKey(name)), definition, name);
			// `.docs` carries one guid deriver per declared child-doc field, so the
			// workspace owns guid derivation end-to-end. The connected opener layers
			// `open(rowId)` onto these same entries (see `connectTableChildDocs`).
			const docs: Record<string, unknown> = {};
			for (const field of Object.keys(definition.docDecls)) {
				docs[field] = {
					guid: (rowId: string): Guid =>
						docGuid({
							workspaceId: options.id,
							collection: name,
							rowId,
							field,
						}),
				};
			}
			return [name, { ...table, docs }];
		}),
	) as WorkspaceTables<TTables>;

	const kv = createKv(attachStore(KV_KEY), options.kv);

	return satisfiesWorkspace({
		ydoc,
		tables,
		kv,
		actions: defineActions({}),
		[Symbol.dispose]() {
			ydoc.destroy();
		},
	});
}

/**
 * Define an isomorphic workspace model, then construct or connect it.
 *
 * `create()` constructs; `connect()` connects:
 *
 *   create()                     Bare root: Y.Doc + tables + KV + actions. No
 *                                persistence, no sync, no child-doc openers. Daemon
 *                                and test runtimes attach their own storage and
 *                                transport around it.
 *   connect(connection)          The browser preset: the bare root plus IndexedDB
 *                                persistence, the WebSocket relay (see `connectDoc`),
 *                                per-row child-doc openers
 *                                (`tables.notes.docs.body.open(rowId)`), and `wipe()`.
 *   connect(connection, compose) The browser preset plus a runtime layer. `compose`
 *                                runs after the doc and child docs are built but
 *                                before collaboration wires, so the action registry
 *                                it returns is the one served for cross-node
 *                                dispatch. That ordering is why `compose` is a
 *                                callback here, not a step you run after `connect()`.
 *
 * `connect(connection)` is `create()` plus the browser storage/transport bundle
 * (`connectTableChildDocs` + `connectDoc`). Non-browser runtimes call `create()`
 * and compose their own infrastructure instead of taking the preset.
 */
export function defineWorkspace<
	TTables extends TableDefinitions,
	TKv extends KvDefinitions,
	TActions extends ActionRegistry = {},
>(
	options: DefineWorkspaceOptions<TTables, TKv, TActions>,
): WorkspaceDefinition<TTables, TKv, TActions> {
	/**
	 * Bare root: Y.Doc + tables + KV + actions. No persistence, no sync, no
	 * child-doc openers. Daemon and test runtimes attach their own
	 * storage/transport around it (see each app's `project.ts`).
	 *
	 * `createWorkspace` builds the doc, tables, and KV with an empty action
	 * registry; the action builder closes over that live root and the result is
	 * merged back onto the same object (which already owns `[Symbol.dispose]`).
	 * `connect()` reuses this as its root, so the action registry has exactly one
	 * construction site.
	 */
	function create(): Workspace<TTables, TKv, TActions> {
		const root = createWorkspace({
			id: options.id,
			tables: options.tables,
			kv: options.kv,
		});
		const actions =
			options.actions === undefined ? ({} as TActions) : options.actions(root);
		return satisfiesWorkspace({ ...root, actions });
	}

	function connect(
		connection: ConnectionConfig,
	): ConnectedWorkspace<TTables, TKv, TActions>;
	function connect<TRuntime extends WorkspaceRuntimeExtension>(
		connection: ConnectionConfig,
		compose: (
			workspace: ConnectedWorkspaceContext<TTables, TKv, TActions>,
		) => TRuntime,
	): ConnectedWorkspaceWithRuntime<TTables, TKv, TRuntime>;
	function connect(
		connection: ConnectionConfig,
		compose: (
			workspace: ConnectedWorkspaceContext<TTables, TKv, TActions>,
		) => WorkspaceRuntimeExtension = (workspace) => ({
			actions: workspace.actions,
		}),
	) {
		const workspace = create();

		// Connect the per-row child-doc openers, then run the caller's composer.
		// compose sees live tables/ydoc and the base actions (carried on
		// `workspace.actions`); the `actions` it returns is final. Omitting it runs
		// the default, which serves the base actions unchanged. The child-doc caches
		// cascade off the root `ydoc.destroy()`, so there is no teardown handle to
		// thread back here.
		const tables = connectTableChildDocs({
			ydoc: workspace.ydoc,
			tables: workspace.tables,
			definitions: options.tables,
			connection,
		});
		const runtime = compose({ ...workspace, tables });
		// Solder infrastructure on top of what compose returned. connectDoc serves
		// `runtime.actions` to peers, so it must run after compose.
		const { idb, collaboration } = connectDoc(workspace.ydoc, connection, {
			actions: runtime.actions,
		});

		// `dispose` is reachable twice: `wipe()` calls it explicitly, then a `using`
		// binding calls it again at scope exit. Neither callee is safe to run twice
		// on its own (the app's `runtime[Symbol.dispose]` is arbitrary, and
		// `ydoc.destroy()` re-emits `destroy` on every call), so `once` collapses
		// the whole teardown to a single run.
		const dispose = once(() => {
			runtime[Symbol.dispose]?.();
			workspace[Symbol.dispose]();
		});

		return satisfiesWorkspace({
			...workspace,
			...runtime,
			tables,
			actions: runtime.actions,
			idb,
			collaboration,
			async wipe() {
				dispose();
				await Promise.all([idb.whenDisposed, collaboration.whenDisposed]);
				await wipeLocalStorage({
					server: connection.server,
					ownerId: connection.ownerId,
				});
			},
			[Symbol.dispose]: dispose,
		});
	}

	return {
		id: options.id,
		tables: options.tables,
		kv: options.kv,
		create,
		connect,
	};
}

/**
 * The bound child-doc runtime: give every declared `table.docs({ field })`
 * a connected `open(rowId)` opener layered onto the field's existing guid
 * deriver.
 *
 * A collaborative body (a chat transcript, a prose note, a code snippet) is its
 * own synced `Y.Doc`. Three concerns recur every time an app opens one, and this
 * function owns all three so apps declare only the shape:
 *
 *  - **lifecycle**: same `rowId` -> one shared `Y.Doc`; N opens require N
 *    disposes; a grace window survives route/pane swaps. One
 *    {@link createDisposableCache} per `(table, field)`, keyed by `rowId`.
 *  - **connection**: local IndexedDB persistence + cloud sync via the same
 *    {@link connectDoc} wiring the root uses. Sync is opened for its side
 *    effect; the `collaboration` handle is intentionally orphaned, and teardown
 *    cascades from `ydoc.destroy()` when the cache evicts the entry.
 *  - **shape**: the CRDT layout and its writer policy, owned by the declared
 *    `attach*(ydoc)` function (`attachPlainText`, `attachRichText`,
 *    `attachChatTranscript`).
 *
 * The guid is only the room address: the cache keys by `rowId`, and the address
 * is derived through the field's existing {@link RowDocGuid} so derivation stays
 * single-owner (`createWorkspace`'s `.docs` loop), never re-grammared here.
 *
 * Teardown mirrors how the root's own stores release: each cache registers on
 * `ydoc.once('destroy', ...)`, so a single root `ydoc.destroy()` flushes every
 * child-doc cache alongside the tables and KV. There is no separate teardown
 * handle to return and thread through `connect()`.
 */
function connectTableChildDocs<TTableDefinitions extends TableDefinitions>({
	ydoc,
	tables,
	definitions,
	connection,
}: {
	ydoc: Y.Doc;
	tables: WorkspaceTables<TTableDefinitions>;
	definitions: TTableDefinitions;
	connection: ConnectionConfig;
}): ConnectedTables<TTableDefinitions> {
	const connectedTables: Record<string, unknown> = {};

	for (const [collection, table] of Object.entries(tables)) {
		const definition = definitions[collection as keyof TTableDefinitions]!;
		const guidDerivers = table.docs as Record<string, RowDocGuid<string>>;
		// A body's only cross-doc writer: a local edit stamps a declared instant
		// column on the row. Typed loosely here because the loop has erased the
		// per-table row type; `touch` is checked against the real row at the
		// `.docs(...)` call site. The returned `Result` is intentionally dropped:
		// a recency bump is best-effort and a rejected patch must not break the
		// edit it followed.
		const updateRow = (
			table as { update: (id: string, patch: object) => unknown }
		).update;
		const docs: Record<string, unknown> = {};

		for (const [field, declaration] of Object.entries(definition.docDecls) as [
			string,
			ChildDocDeclaration,
		][]) {
			// Normalize the two declaration forms once: a bare layout function is
			// sugar for `{ layout, touch: undefined }`.
			const { layout, touch } =
				typeof declaration === 'function'
					? { layout: declaration, touch: undefined }
					: declaration;
			// Reuse the guid deriver the unconnected root already built for this
			// field, so derivation stays single-owner (`createWorkspace`'s `.docs`
			// loop). The cache keys by `rowId`; the guid is only the room address.
			const guidEntry = guidDerivers[field]!;
			const cache = createDisposableCache((rowId: string) => {
				const guid = guidEntry.guid(rowId);
				const bodyDoc = new Y.Doc({ guid, gc: true });
				// A body is a doc like any other; `connectDoc` is the same wiring the
				// root uses. No action registry: the body's only writers are the
				// `attach*` layout and the server generation actor streaming in.
				const { idb } = connectDoc(bodyDoc, connection);
				// Recency: a local edit bumps a column on the row. One observer per
				// shared body Y.Doc (built here, not per `open`), torn down on
				// eviction. `tx.local` scopes it to local edits, so remote/hydrated
				// updates never bump the row; writing the root row can't re-trigger
				// this child-doc observer, so there is no loop.
				const offLocalEdit = touch
					? onLocalUpdate(bodyDoc, () =>
							updateRow(rowId, { [touch]: InstantString.now() }),
						)
					: undefined;
				return {
					...layout(bodyDoc),
					/** The underlying Y.Doc, exposed for runtime attachments. */
					ydoc: bodyDoc,
					/** The doc's guid (its room id). */
					guid,
					/** Resolves when local IndexedDB state has replayed into the doc. */
					whenLoaded: idb.whenLoaded,
					[Symbol.dispose]() {
						offLocalEdit?.();
						bodyDoc.destroy();
					},
				};
			});
			// Flush this field's cache when the root doc is destroyed, exactly as
			// `createWorkspace` releases each table/KV store. The root never holds
			// these body docs as subdocs, so the hook is what cascades teardown.
			ydoc.once('destroy', () => cache[Symbol.dispose]());
			// The connected handle only ADDS `open(rowId)` to the field's existing
			// guid deriver; `open(rowId)` keys the cache by `rowId` directly.
			docs[field] = {
				...guidEntry,
				open(rowId: string) {
					return cache.open(rowId);
				},
			};
		}

		connectedTables[collection] = {
			...table,
			docs,
		};
	}

	return connectedTables as ConnectedTables<TTableDefinitions>;
}
