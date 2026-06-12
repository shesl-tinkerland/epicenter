/**
 * Shared types and teardown helpers for the materializer family (sqlite +
 * markdown). Each materializer is generic over a record of materialized
 * workspace tables; `TablesRecord` is the structural bound those generics
 * share and `AnyTable` is the variance-friendly element shape they both pass
 * around internally. `settledWithin` is the bounded wait both families use to
 * drain pending projection work at dispose.
 */

import type * as Y from 'yjs';
import type { Table } from '../table.js';

/**
 * Await `work`, but give up after `timeoutMs` so a hung drain (e.g. a stuck
 * HTTP body read inside a render) cannot wedge teardown. Returns whether the
 * work settled in time. A rejection counts as settled: drain callers report
 * failures through their own logging channels, not through this wait.
 */
export async function settledWithin(
	work: Promise<unknown>,
	timeoutMs: number,
): Promise<boolean> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const didSettle = await Promise.race([
		work.then(
			() => true,
			() => true,
		),
		new Promise<false>((resolve) => {
			timer = setTimeout(() => resolve(false), timeoutMs);
		}),
	]);
	clearTimeout(timer);
	return didSettle;
}

/**
 * Variance-friendly handle for a single workspace table whose row type the
 * materializer body doesn't need to know. Used in internal registries that
 * hold heterogeneous tables under one key.
 */
// biome-ignore lint/suspicious/noExplicitAny: variance-friendly element type
export type AnyTable = Table<any>;

/**
 * Structural bound for materializer table inputs: a record mapping table
 * names to materialized `Table<TRow>` instances. Satisfied by
 * `workspace.tables` (which is `Tables<TDefs>`) and by hand-rolled subsets
 * like `{ posts: workspace.tables.posts }`.
 */
export type TablesRecord = Record<string, AnyTable>;

/**
 * The minimal slice of a workspace a materializer needs: the root `Y.Doc` plus
 * the live table handles to project. Deliberately NOT `Workspace<...>`, which is
 * generic over table DEFINITIONS and also carries kv/actions/dispose; a
 * materializer is generic over the already-instantiated `TablesRecord` so its
 * per-table config can map over the table names. Satisfied by a full workspace
 * (a superset) or a hand-rolled subset like `{ ydoc, tables: { posts } }`.
 */
export type MaterializerInput<TTableHandles extends TablesRecord> = {
	ydoc: Y.Doc;
	tables: TTableHandles;
};
