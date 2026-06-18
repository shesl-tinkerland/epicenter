/**
 * Workspace definitions and root Y.Doc construction.
 *
 * `defineWorkspace({ id, name, tables, kv })` is the app-facing entry point and
 * the one handle every runtime shares:
 *
 *   .create()            bare isomorphic doc for tests and advanced runtimes
 *   .connect(connection) browser runtime: local storage, sync, wipe, row
 *                        child-doc openers
 *   .mount(options)      daemon runtime: the same root plus Yjs-log persistence,
 *                        cloud sync, and materializers, with every node
 *                        dependency injected through `options.runtime`
 *                        (`nodeMountRuntime()` from `@epicenter/workspace/node`)
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
 * `options.id` is the identity input for both constructors, stamped onto the
 * Y.Doc as `guid`; `defineWorkspace` adds a display-only `name`. The app owns
 * its `id` namespace (e.g. `epicenter-fuji`), so this library never derives or
 * prefixes it. `workspace.ydoc.guid` is the canonical read, and downstream code
 * should read it rather than re-deriving the id.
 *
 * @module
 */

import { InstantString } from '@epicenter/field';
import * as Y from 'yjs';
import { createDisposableCache } from '../cache/disposable-cache.js';
// Type-only daemon imports: `verbatimModuleSyntax` erases them, so the browser
// barrel never traverses the node-only mount runtime. `.mount()` is a pure
// coordinator that receives every node capability through its `runtime`
// argument (built by `nodeMountRuntime()` from `@epicenter/workspace/node`).
import type { Mount, SessionMountContext } from '../daemon/define-mount.js';
import type { NodeMountRuntime } from '../daemon/mount-runtime.js';
import { type ActionRegistry, defineActions } from '../shared/actions.js';
import type { Guid } from '../shared/id.js';
import { once } from '../shared/once.js';
import { assertSafeSegment } from '../shared/safe-segment.js';
import type { Drainable } from '../shared/types.js';
import type { AgentId } from './agent-id.js';
import {
	attachChildDocActor,
	type ChildDocActor,
	type ChildDocActorFactory,
	type ConnectedChildDoc,
	type ObservableChildDocLayout,
} from './child-doc-actor.js';
import { type ConnectionConfig, connectDoc } from './connect-doc.js';
import { docGuid } from './doc-guid.js';
import { KV_KEY, TableKey } from './keys.js';
import { createKv, type Kv, type KvDefinitions } from './kv.js';
import { onLocalUpdate } from './on-local-update.js';
import type { Collaboration } from './open-collaboration.js';
import { assertReferenceTargets } from './reference-check.js';
import {
	type BaseRow,
	type ChildDocDeclaration,
	type ChildDocDeclarations,
	createTable,
	type InferTableRow,
	type LayoutOf,
	type Table,
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
	 * Human-facing display label: `epicenter list`'s header, the `${name}-*`
	 * materializer logger prefix, and the "Sign in to enable <name>." message. A
	 * display name only, not an identity seed: it never feeds the guid, the node
	 * id, the Y.Doc `clientID`, or the action namespace, so the app's `id` owns
	 * the namespace and the `name` is free to be a friendly label.
	 */
	name: string;
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
 *
 * Receive-side twin of {@link MountComposeContext}, but deliberately not shaped
 * to rhyme with it: this *is* the connected workspace (it also bases
 * {@link ConnectedWorkspace}), so the composer extends it, whereas a mount
 * composer receives the workspace wrapped in a `{ workspace, scope }` bag. The
 * names rhyme only where the shapes do, on the return twins
 * {@link ConnectComposition} / {@link MountComposition}.
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
 * registry plus any runtime-only handles the app wants on the bundle. The
 * browser twin of {@link MountComposition}: both are "what the compose callback
 * composes," one for the browser runtime, one for the daemon.
 *
 * `actions` is required, not optional: a runtime builder is exactly where
 * browser-only actions get layered onto the base registry, and that returned
 * registry is the one collaboration serves for cross-node dispatch. Returning
 * `{ actions: workspace.actions }` (the base, unchanged) is the explicit way to
 * say "no new actions" — there is no implicit fallback to guess at.
 */
export type ConnectComposition<
	TActions extends ActionRegistry = ActionRegistry,
> = {
	readonly actions: TActions;
	[Symbol.dispose]?(): void;
};

type ConnectedWorkspaceWithRuntime<
	TTables extends TableDefinitions,
	TKv extends KvDefinitions,
	TRuntime extends ConnectComposition,
> = ConnectedWorkspace<TTables, TKv, TRuntime['actions']> &
	Omit<TRuntime, 'actions' | typeof Symbol.dispose>;

/**
 * The ambient capabilities a mount's `open()` hands its `compose` body: the
 * signed-in session `ctx` (durable node id, resolved Epicenter root, transport
 * refs), the resolved sync `baseURL`, and `registerDrain`, the lifecycle sink
 * that enrolls a materializer's teardown barrier for ordered drain on shutdown.
 *
 * `registerDrain` is what makes a dropped projection write impossible to cause
 * by hand. `attachMountSqlite` / `attachMountMarkdown` call it when they attach,
 * so a `compose` body never lists materializers and cannot forget to drain one:
 * the obligation is discharged by the same call that creates the side effect.
 * It is plain data (a closure over an array the coordinator owns), so the
 * browser barrel that ships `.mount()` stays free of any node import.
 */
export type MountComposeScope = {
	readonly ctx: SessionMountContext;
	readonly baseURL: string;
	readonly registerDrain: (drainable: Drainable) => void;
};

/**
 * What a mount's `compose` callback sees: the bare daemon root `workspace` and
 * the ambient `scope` (session ctx, resolved baseURL, drain sink).
 *
 * Materializers are attached by the body itself: a mount's `compose` is node
 * code, so it imports `attachMountSqlite` / `attachMountMarkdown` from
 * `@epicenter/workspace/node` and calls them with `scope` (for ctx and drain
 * registration) and `workspace` (the subject to project). The coordinator never
 * touches a materializer, which is why it stays browser-safe.
 *
 * `workspace` is the unconnected root, so `workspace.tables.<t>.docs.<f>.guid`
 * is the same guid deriver the browser opener uses, letting a daemon read a
 * child-doc body over HTTP at the address the browser writes it.
 *
 * Receive-side twin of {@link ConnectedWorkspaceContext}, but deliberately not
 * shaped to rhyme: that one *is* the connected workspace, while this one wraps
 * the unconnected root in a `{ workspace, scope }` bag, since a mount composer
 * attaches its own materializers rather than extending the workspace. The rhyme
 * lives on the return twins {@link MountComposition} / {@link ConnectComposition}.
 */
export type MountComposeContext<
	TTables extends TableDefinitions,
	TKv extends KvDefinitions,
	TActions extends ActionRegistry,
> = {
	readonly workspace: Workspace<TTables, TKv, TActions>;
	readonly scope: MountComposeScope;
};

/**
 * What a mount's `compose` callback returns: the action registry the daemon
 * serves. The daemon twin of {@link ConnectComposition}.
 *
 * `actions` is the explicit served set, exactly as the browser `connect`
 * composer is: this is where the daemon refuses browser-only actions and admits
 * its materializer actions. Materializer teardown is deliberately not returned
 * here: each `attachMount*` helper enrolls its own drain through
 * `scope.registerDrain`, so the served-action choice is the only decision a body
 * makes. The asymmetry is the point: draining a materializer is an obligation
 * (always wanted), while which actions to serve is a policy (the body's call).
 */
export type MountComposition<TActions extends ActionRegistry> = {
	readonly actions: TActions;
};

/**
 * The daemon child-doc actors a mount registers, keyed by table then by
 * child-doc field, to a per-body {@link ChildDocActorFactory}. The keys are
 * typed against the schema (only declared tables, and only each table's declared
 * child-doc fields), and each factory's `handle` is the field's declared layout
 * return type. So the app supplies behavior alone: the table, the field's guid
 * deriver, and the layout all come from the schema, never re-passed at the call
 * site.
 *
 * Registering a field is what makes the daemon host and observe its bodies; a
 * field left out is opened on demand by browser UI, not held live by the actor.
 *
 * Only fields whose layout exposes `observe` can be registered: the loop watches
 * each body through it, so a layout without one (e.g. `attachPlainText`) collapses
 * to `never` and the field cannot carry an actor. `attachChatTranscript` does.
 */
export type MountActors<TTables extends TableDefinitions> = {
	[T in keyof TTables]?: TTables[T] extends TableDefinition<
		any,
		infer TDecls extends ChildDocDeclarations
	>
		? {
				[F in keyof TDecls]?: ReturnType<LayoutOf<TDecls[F]>> extends {
					observe(callback: () => void): () => void;
				}
					? ChildDocActorFactory<
							InferTableRow<TTables[T]>['id'],
							ReturnType<LayoutOf<TDecls[F]>>
						>
					: never;
			}
		: never;
};

/**
 * Options for `definition.mount(...)`, the daemon runtime. The mount's display
 * label comes from the definition's `name` (see `defineWorkspace`), so the only
 * per-mount inputs are the sync base URL, the injected node runtime, the
 * optional composer, and the optional child-doc actors.
 *
 * `runtime` is the injected node bag from `nodeMountRuntime()`; `.mount()`
 * itself imports no node module. `compose` is optional: omit it to serve the
 * workspace's base actions with no materializers (a pure sync-and-persist
 * mirror); provide it to attach materializers (each enrolling its own drain
 * through `scope.registerDrain`) and choose the served action set.
 *
 * `compose` returns `MountComposition<ActionRegistry>`: the served set is its
 * own decision and never surfaces on the returned non-generic {@link Mount}, so
 * the option carries no `TRuntimeActions` generic and the coordinator reads both
 * the compose and no-compose branches as one composition type, no cast.
 */
export type MountOptions<
	TTables extends TableDefinitions,
	TKv extends KvDefinitions,
	TActions extends ActionRegistry,
> = {
	/**
	 * Explicit sync base URL. Omit to fall back through `EPICENTER_API_URL` to
	 * the hosted API (resolved by `runtime.resolveBaseURL`).
	 */
	readonly baseURL?: string;
	/** Injected node runtime, built by `nodeMountRuntime()`. */
	readonly runtime: NodeMountRuntime;
	/**
	 * Attach materializers and select the served actions. Omit for a pure
	 * sync-and-persist mirror. See {@link MountComposition}.
	 */
	readonly compose?: (
		context: MountComposeContext<TTables, TKv, TActions>,
	) => MountComposition<ActionRegistry>;
	/**
	 * Register daemon child-doc actors: the always-on observe loops that host a
	 * live replica of a row's child doc and watch it (ADR-0014/0015). Keyed by
	 * table then field, to a per-body factory. Identity and shape (the table, the
	 * guid, the layout) come from the schema; the factory supplies only behavior.
	 * See {@link MountActors}.
	 */
	readonly actors?: MountActors<TTables>;
	/**
	 * The agent identity this daemon answers as (ADR-0015). A conversation row
	 * names the one agent it is bound to in its `agent` column; the observe loop
	 * hosts and answers exactly the rows whose `agent` equals this id. Authored in
	 * configuration (the durable, stable address), not derived from the per-install
	 * `nodeId`. Omit it for a daemon with no configured agent: it then hosts
	 * nothing, leaving every conversation to its own bound agent.
	 */
	readonly agentId?: AgentId;
};

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
	connect<TRuntime extends ConnectComposition>(
		connection: ConnectionConfig,
		compose: (
			workspace: ConnectedWorkspaceContext<TTables, TKv, TActions>,
		) => TRuntime,
	): ConnectedWorkspaceWithRuntime<TTables, TKv, TRuntime>;
	mount(options: MountOptions<TTables, TKv, TActions>): Mount;
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
	// Referential floor: every field.reference(table) column must name a table defined in
	// this same workspace. Throws here so a dangling target fails at construction, not
	// silently at query time. A no-op unless a table actually uses field.reference().
	assertReferenceTargets(options.tables);
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
			const docs = Object.fromEntries(
				Object.keys(definition.docDecls).map((field) => [
					field,
					{
						guid: (rowId: string): Guid =>
							docGuid({
								workspaceId: options.id,
								collection: name,
								rowId,
								field,
							}),
					},
				]),
			);
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
 *   mount(options)               The daemon preset: `create()` plus Yjs-log
 *                                persistence, cloud sync, and materializers, with
 *                                node dependencies injected through
 *                                `options.runtime`. Its `compose` mirrors the
 *                                browser one (select daemon actions, attach
 *                                materializers); see `mount` below.
 *
 * `connect(connection)` is `create()` plus the browser storage/transport bundle
 * (`connectTableChildDocs` + `connectDoc`). `mount(options)` is `create()` plus
 * the daemon storage/transport bundle, coordinated over injected node functions
 * so the browser barrel that ships this definition never imports a node module.
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
	function connect<TRuntime extends ConnectComposition>(
		connection: ConnectionConfig,
		compose: (
			workspace: ConnectedWorkspaceContext<TTables, TKv, TActions>,
		) => TRuntime,
	): ConnectedWorkspaceWithRuntime<TTables, TKv, TRuntime>;
	function connect(
		connection: ConnectionConfig,
		compose: (
			workspace: ConnectedWorkspaceContext<TTables, TKv, TActions>,
		) => ConnectComposition = (workspace) => ({
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

	/**
	 * Daemon runtime: the bare root plus disk persistence, cloud sync, and
	 * materializers. A pure coordinator over the injected `options.runtime`, so
	 * this method (and the browser barrel that ships it) never imports a node
	 * module. It collapses the ritual every mount used to repeat by hand: wrap in
	 * `defineSessionMount`, resolve the base URL, `create()` the root, run the
	 * caller's `compose`, attach mount infrastructure, and assemble the runtime.
	 *
	 * `compose` is the one place daemon actions are chosen, so a mount cannot
	 * accidentally serve browser-only actions: omit it to serve the base
	 * `workspace.actions` with no materializers, or return an explicit
	 * `{ actions }` after attaching materializers, which enroll their own drain.
	 *
	 * The mount's display label is the definition's `name`, declared once on the
	 * definition rather than restated at every call site.
	 */
	function mount(mountOptions: MountOptions<TTables, TKv, TActions>): Mount {
		const { runtime } = mountOptions;
		return runtime.defineSessionMount({
			name: options.name,
			open(ctx) {
				const baseURL = runtime.resolveBaseURL(mountOptions.baseURL);
				const workspace = create();
				// The coordinator owns the drain registry for this open(): the
				// `scope.registerDrain` it hands compose pushes here, and the
				// collected barriers go to infrastructure so a shutdown awaits every
				// materializer's pending projection write. compose never returns
				// materializers; the attach helpers enroll themselves.
				const drains: Drainable[] = [];
				const scope: MountComposeScope = {
					ctx,
					baseURL,
					registerDrain: (drainable) => {
						drains.push(drainable);
					},
				};
				// Both branches are one composition type: compose returns
				// `MountComposition<ActionRegistry>`, and the no-compose fallback's
				// `workspace.actions` (`TActions`) widens to the same. No generic to
				// bridge, so no cast.
				const composition: MountComposition<ActionRegistry> =
					mountOptions.compose
						? mountOptions.compose({ workspace, scope })
						: { actions: workspace.actions };
				// Schema-driven child-doc actors. The coordinator reads the layout
				// and guid deriver from the definition (never re-passed by the app),
				// so an actor cannot interpret a body with a layout that disagrees
				// with the schema. Each actor enrolls its own drain. Runs before
				// infrastructure so the loops are observing the root table by the
				// time sync starts to fill it.
				if (mountOptions.actors) {
					connectMountActors({
						actors: mountOptions.actors,
						workspace,
						definitions: options.tables,
						connectBody: runtime.connectChildDoc(ctx, baseURL),
						selfAgentId: mountOptions.agentId,
						registerDrain: scope.registerDrain,
					});
				}
				// `attachInfrastructure` serves `composition.actions` to peers and
				// drains every registered materializer in order on shutdown, so it
				// runs after compose has registered them.
				const infrastructure = runtime.attachInfrastructure(
					workspace.ydoc,
					ctx,
					{
						baseURL,
						actions: composition.actions,
						materializers: drains,
					},
				);
				return {
					...workspace,
					...infrastructure,
					actions: composition.actions,
				};
			},
		});
	}

	return {
		id: options.id,
		tables: options.tables,
		kv: options.kv,
		create,
		connect,
		mount,
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
		// column on the row. Read through `Table<BaseRow>` (not a hand-written
		// `{ update }` shape): `Object.entries` erased the per-table row type, and
		// the base-row view's `update` accepts a `Partial<{}>` patch, which is
		// exactly the dynamic `{ [touch]: instant }` we build here. `touch` is
		// checked against the real row type at the `.docs(...)` call site. The
		// returned `Result` is intentionally dropped: a recency bump is best-effort
		// and a rejected patch must not break the edit it followed.
		const { update: updateRow } = table as Table<BaseRow>;
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

/**
 * Wire the schema-driven daemon child-doc actors for a mount, the browser-safe
 * twin of {@link connectTableChildDocs}.
 *
 * For every `(table, field)` the mount registered an actor on, read the field's
 * layout from the definition and its guid deriver from the workspace's own
 * `.docs` namespace, then run {@link attachChildDocActor} over the injected node
 * `connectBody`. The app supplied only the per-body factory, so identity (the
 * guid) and shape (the layout) stay single-owner: an actor can never read a body
 * with a layout that disagrees with the schema, the way a hand-passed `layout`
 * would allow.
 *
 * Each actor enrolls its drain through `registerDrain`; its body teardown
 * cascades off the root `ydoc.destroy()` inside {@link attachChildDocActor}, so
 * there is no handle to thread back.
 */
function connectMountActors<TTableDefinitions extends TableDefinitions>({
	actors,
	workspace,
	definitions,
	connectBody,
	selfAgentId,
	registerDrain,
}: {
	actors: MountActors<TTableDefinitions>;
	workspace: Workspace<TTableDefinitions, KvDefinitions, ActionRegistry>;
	definitions: TTableDefinitions;
	connectBody: (guid: string) => ConnectedChildDoc;
	/**
	 * The agent identity this daemon answers as, or `undefined` when no agent is
	 * configured (it then designates nothing). The loop hosts exactly the rows
	 * whose `agent` equals it.
	 */
	selfAgentId: AgentId | undefined;
	registerDrain: (drainable: ChildDocActor) => void;
}): void {
	// `Object.entries` erases the per-table types the public `MountActors` already
	// enforced, so the loop body works in the widened `string`/`unknown` forms and
	// casts at the schema reads (layout, guid) and the designation read.
	for (const [collection, fieldActors] of Object.entries(actors) as [
		string,
		Record<string, ChildDocActorFactory<string, unknown>> | undefined,
	][]) {
		if (fieldActors === undefined) continue;
		const definition = definitions[collection as keyof TTableDefinitions]!;
		// One structural view of the connected table: the loop reads its
		// schema-derived guid derivers, scans/observes its rows, and reads a row's
		// bound `agent` to decide designation. `get` returns the row or `null`.
		const table = workspace.tables[
			collection as keyof TTableDefinitions
		] as unknown as {
			docs: Record<string, RowDocGuid<string>>;
			scan(): { rows: ReadonlyArray<{ id: string }> };
			observe(callback: () => void): () => void;
			get(id: string): { data: { agent?: AgentId } | null };
		};
		// The designation contract (ADR-0015): a daemon hosts and answers exactly
		// the rows bound to the agent it answers as. Composed once here, the single
		// owner of the rule, so an app's actor factory supplies behavior alone. A
		// daemon with no configured agent (`selfAgentId` undefined) designates
		// nothing, so every conversation is left to its own bound agent.
		const isDesignated = (rowId: string): boolean =>
			selfAgentId !== undefined && table.get(rowId).data?.agent === selfAgentId;

		for (const [field, actorFor] of Object.entries(fieldActors)) {
			if (actorFor === undefined) continue;
			// Layout and guid both come from the schema, never the call site.
			const declaration = definition.docDecls[field] as ChildDocDeclaration;
			const layout =
				typeof declaration === 'function' ? declaration : declaration.layout;
			const guidEntry = table.docs[field]!;
			const actor = attachChildDocActor<string, unknown>({
				rootDoc: workspace.ydoc,
				table,
				guidFor: (rowId) => guidEntry.guid(rowId),
				connectBody,
				layout: layout as unknown as ObservableChildDocLayout<unknown>,
				actorFor,
				isDesignated,
			});
			registerDrain(actor);
		}
	}
}
