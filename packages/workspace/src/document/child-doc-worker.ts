/**
 * The child-doc observe loop: the daemon-side worker (ADR-0024) that hosts a live
 * replica of every conversation bound to the agent THIS daemon answers as and
 * watches it.
 *
 * ADR-0024 splits two roles one device may host but never in one code path: the
 * app-blind ANCHOR/relay stores and routes opaque room bytes for availability
 * (it keeps every conversation reachable while knowing no schema), and the
 * app-aware worker holds a live typed replica of the docs it answers. This loop is
 * the worker, so it reconciles only the conversations bound to its agent
 * (ADR-0025: designation is the row's `agent`). A conversation bound to another
 * agent stays available through the anchor, never hosted here: filtering to the
 * designated set is exactly what keeps the worker out of the anchor's job.
 *
 * The daemon mount hosts the root Y.Doc on disk and over cloud sync, but a
 * conversation transcript is not a row, it is a separate child doc keyed by the
 * row id (see {@link connectTableChildDocs}, the browser twin that hands the UI
 * `tables.<t>.docs.<field>.open(rowId)`). The worker needs its designated bodies
 * live so it can watch an unanswered turn and stream a reply into it. This is
 * that loop:
 *
 *  - **enumerate**: read the watched table, keep the rows designated to this node
 *    (`isDesignated`), and open each one's child doc through the field's
 *    single-owner guid deriver (`guidFor`).
 *  - **connect**: each opened body is persisted and synced by `connectBody`, the
 *    node-only wiring injected by the mount coordinator. The loop itself stays
 *    transport-agnostic, so the browser-safe coordinator can call it and a test
 *    drives it with an in-memory connector.
 *  - **observe**: shape each body with the field's declared `layout` and build a
 *    per-body `worker` for it; every transcript transaction calls the worker's
 *    `onChange`. That is the seam V0.3 fills with claim -> stream -> finish.
 *  - **dispose**: a body whose row was removed OR re-designated away from this
 *    node is torn down. On root `ydoc.destroy()` (a daemon shutdown), every
 *    hosted body is destroyed and its teardown awaited, the same cascade
 *    {@link connectTableChildDocs} uses.
 *
 * The loop never writes the root table, so its own opens cannot re-trigger the
 * table observer; there is no feedback loop. Because it re-runs on every table
 * change, a designation written to a row opens or closes its body reactively.
 *
 * The app declares nothing about identity or shape here: the table, the field's
 * guid deriver, and the layout all come from the schema, exactly as the browser
 * opener derives them. The app supplies only behavior, the per-body `worker`.
 *
 * @module
 */

import { createLogger, type Logger } from 'wellcrafted/logger';
import type * as Y from 'yjs';
import type { Drainable } from '../shared/types.js';

/**
 * A connected child-doc body the worker hosts: a live Y.Doc persisted and synced
 * by the injected connector. `dispose()` destroys the doc, cascading the
 * connector's own teardown; `whenDisposed` resolves once that teardown settles.
 */
export type ConnectedChildDoc = Drainable & {
	readonly ydoc: Y.Doc;
	/** Stop persisting and syncing this body. Cascades from `ydoc.destroy()`. */
	dispose(): void;
};

/**
 * The declared child-doc layout, narrowed to what the loop needs: shape a body
 * doc and observe its changes. `attachKvStore` satisfies this.
 */
export type ObservableChildDocLayout<THandle> = (
	ydoc: Y.Doc,
) => THandle & { observe(callback: () => void): () => void };

/**
 * What an app registers per child-doc field: the behavior the daemon runs on a
 * hosted body. Built once per opened body, it reacts to changes and cleans up on
 * teardown. Both members are optional, so a pure observe-and-host registration
 * is `() => ({})`; V0.3 fills `onChange` with claim -> stream -> finish.
 */
export type ChildDocWorkerHandle = {
	/** React to a body change (a new message, a token append, a finish write). */
	onChange?(): void;
	/** Clean up when the body is torn down (row removed or shutdown). */
	[Symbol.dispose]?(): void;
};

/** Per-body context handed to a {@link ChildDocWorkerFactory}. */
export type ChildDocWorkerContext<TRowId extends string, THandle> = {
	/** The row whose child doc this body is. */
	readonly rowId: TRowId;
	/** The body shaped by the field's declared layout. */
	readonly handle: THandle;
	/** The underlying body Y.Doc, for runtime attachments. */
	readonly ydoc: Y.Doc;
};

/**
 * Build the per-body behavior for one hosted child doc. Invoked once per opened
 * body, so it may close over per-body state (an in-flight generation, the
 * claimed id). The app's only input to the observe loop. Designation is the
 * loop's concern, not the factory's: it is only ever invoked for a body this
 * node is designated to host, so the behavior it builds always answers.
 */
export type ChildDocWorkerFactory<TRowId extends string, THandle> = (
	context: ChildDocWorkerContext<TRowId, THandle>,
) => ChildDocWorkerHandle;

export type ChildDocWorkerConfig<TRowId extends string, THandle> = {
	/**
	 * The table whose rows name the child docs to host. Read with `scan()` and
	 * watched with `observe()`; every change reconciles the open set.
	 */
	readonly table: {
		scan(): { readonly rows: ReadonlyArray<{ readonly id: TRowId }> };
		observe(callback: () => void): () => void;
	};
	/**
	 * Derive a row's child-doc room address. The field's single-owner guid
	 * deriver (`tables.<t>.docs.<field>.guid`), so the worker reads a body at the
	 * same address the browser opener writes it.
	 */
	readonly guidFor: (rowId: TRowId) => string;
	/** Connect (persist + sync) a body doc for a derived guid. Node-only; injected. */
	readonly connectBody: (guid: string) => ConnectedChildDoc;
	/** Shape an opened body into its typed handle (the field's declared layout). */
	readonly layout: ObservableChildDocLayout<THandle>;
	/** Build the per-body behavior. The app's only input. */
	readonly workerFor: ChildDocWorkerFactory<TRowId, THandle>;
	/**
	 * Whether this daemon hosts (and so answers) a row's child doc. The worker
	 * reconciles only the conversations bound to its agent (ADR-0025: the row's
	 * `agent` names it); the mount composes this as `row.agent === selfAgentId`.
	 * Re-evaluated on every table change, so a re-binding opens or closes the body
	 * reactively. A conversation bound to another agent is left to the app-blind
	 * anchor, never hosted here.
	 */
	readonly isDesignated: (rowId: TRowId) => boolean;
	/**
	 * The root doc whose `destroy` flushes every hosted body, the same cascade
	 * {@link connectTableChildDocs} uses for the browser child-doc caches.
	 */
	readonly rootDoc: Y.Doc;
	readonly log?: Logger;
};

/** The running worker: a drainable whose teardown awaits every hosted body. */
export type ChildDocWorker = Drainable & {
	[Symbol.dispose](): void;
};

/**
 * Run the child-doc observe loop over one table field.
 *
 * Transport-agnostic: the loop owns enumeration, observation, and lifecycle, but
 * persistence and sync arrive through the injected `connectBody`, so this body
 * imports no node module. The node-only connector and the schema-driven wiring
 * live in the mount coordinator.
 */
export function attachChildDocWorker<TRowId extends string, THandle>(
	config: ChildDocWorkerConfig<TRowId, THandle>,
): ChildDocWorker {
	const {
		table,
		guidFor,
		connectBody,
		layout,
		workerFor,
		isDesignated,
		rootDoc,
	} = config;
	const log = config.log ?? createLogger('workspace/child-doc-worker');

	type Hosted = {
		body: ConnectedChildDoc;
		worker: ChildDocWorkerHandle;
		unobserve: () => void;
	};
	const hosted = new Map<TRowId, Hosted>();
	let disposed = false;
	const { promise: whenDisposed, resolve: resolveDisposed } =
		Promise.withResolvers<void>();

	function open(rowId: TRowId): void {
		if (hosted.has(rowId)) return;
		const body = connectBody(guidFor(rowId));
		const handle = layout(body.ydoc);
		const worker = workerFor({ rowId, handle, ydoc: body.ydoc });
		const unobserve = handle.observe(() => worker.onChange?.());
		hosted.set(rowId, { body, worker, unobserve });
	}

	function close(rowId: TRowId): void {
		const entry = hosted.get(rowId);
		if (entry === undefined) return;
		hosted.delete(rowId);
		// Stop firing onChange, let the worker clean up while the doc is still
		// readable, then destroy the body.
		entry.unobserve();
		entry.worker[Symbol.dispose]?.();
		entry.body.dispose();
	}

	function reconcile(): void {
		if (disposed) return;
		// Host only the conversations bound to this daemon's agent (ADR-0025); the
		// rest stay available through the app-blind anchor, not in this worker's
		// replica set (ADR-0024: worker and anchor are never one code path).
		const wanted = new Set(
			table
				.scan()
				.rows.map((row) => row.id)
				.filter(isDesignated),
		);
		for (const rowId of wanted) open(rowId);
		// Dispose a hosted body whose row is gone OR no longer designated here.
		for (const rowId of [...hosted.keys()]) {
			if (!wanted.has(rowId)) close(rowId);
		}
	}

	const unobserveTable = table.observe(() => reconcile());
	reconcile();

	async function dispose(): Promise<void> {
		if (disposed) return;
		disposed = true;
		unobserveTable();
		// Tear down every hosted body, then await each connector's teardown so a
		// daemon shutdown cannot drop a body's pending write or socket close.
		const draining = [...hosted.values()].map((entry) => {
			entry.unobserve();
			entry.worker[Symbol.dispose]?.();
			entry.body.dispose();
			return entry.body.whenDisposed;
		});
		hosted.clear();
		try {
			await Promise.all(draining);
		} catch (cause) {
			log.warn(new Error('child-doc worker body teardown threw', { cause }));
		} finally {
			resolveDisposed();
		}
	}

	// Root destroy cascades the worker's teardown, the same way the root's own
	// stores and the browser child-doc caches release on `ydoc.destroy()`.
	rootDoc.once('destroy', () => {
		void dispose();
	});

	return {
		whenDisposed,
		[Symbol.dispose]() {
			void dispose();
		},
	};
}
