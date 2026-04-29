/**
 * Mapped types that rewrite an in-process workspace shape into its
 * remote (RPC) equivalent. The remote workspace is what
 * `buildRemoteWorkspace<T>(client, name)` returns; this file owns its
 * compile-time shape.
 *
 * Two transforms:
 *
 *   tables[K]:  Table<TRow>           ->  RemoteTable<TRow>
 *   actions:    nested Action tree    ->  nested wrapped tree
 *
 * For tables, we expose only the wire-callable subset (CRUD). `filter`,
 * `observe`, and live document handles are intentionally absent from the
 * type so call sites cannot reach for them; the runtime proxy still
 * surfaces them as `RemoteNotSupported`-throwing stubs in case some
 * destructuring path encounters one.
 *
 * For actions, we delegate to `RemoteActions<A>` from `shared/actions.ts`
 * (the same machinery `peer<T>(...)` uses), which wraps every leaf into
 * `(...args) => Promise<Result<T, E | RpcError>>`. That way the remote
 * action shape stays in lockstep with cross-peer RPC.
 */

import type { Result } from 'wellcrafted/result';

import type { BaseRow, Table } from '../document/attach-table.js';
import type { Actions, RemoteActions } from '../shared/actions.js';
import type { TableParseError } from '../document/attach-table.js';
import type { DaemonError } from '../daemon/client.js';
import type { ResolveError } from '../daemon/resolve-entry.js';
import type { RunError } from '../daemon/run-errors.js';
import type { PeerSnapshot } from '../daemon/app.js';

/**
 * Domain errors any remote workspace call can fail with, in addition to
 * the per-action error type. Internal: surfaces in `RemoteTable<TRow>`
 * method signatures.
 */
type RemoteCallError =
	| DaemonError
	| ResolveError
	| RunError
	| TableParseError;

/**
 * The wire-callable subset of a `Table`. Methods that need a live document
 * (predicate filter, observe, document handles) are deliberately omitted
 * from the type. The runtime proxy throws `RemoteNotSupported` if anyone
 * reaches for them dynamically.
 */
export type RemoteTable<TRow extends BaseRow> = {
	get(input: {
		id: TRow['id'];
	}): Promise<Result<TRow | null, RemoteCallError>>;
	getAllValid(): Promise<Result<TRow[], RemoteCallError>>;
	set(row: TRow): Promise<Result<void, RemoteCallError>>;
	update(
		input: { id: TRow['id'] } & Partial<Omit<TRow, 'id'>>,
	): Promise<Result<TRow | null, RemoteCallError>>;
	delete(input: {
		id: TRow['id'];
	}): Promise<Result<void, RemoteCallError>>;
	bulkSet(input: { rows: TRow[] }): Promise<Result<void, RemoteCallError>>;
};

/** Recursively map a `Tables` map (in-process) to remote tables. */
type RemoteTablesOf<TS> = {
	[K in keyof TS]: TS[K] extends Table<infer TRow>
		? RemoteTable<TRow>
		: never;
};

/** Remote workspace shape derived from the in-process workspace `T`. */
export type RemoteWorkspace<T> = {
	tables: T extends { tables: infer TS }
		? RemoteTablesOf<TS>
		: Record<string, never>;
	actions: T extends { actions: infer AS }
		? AS extends Actions
			? RemoteActions<AS>
			: Record<string, never>
		: Record<string, never>;
	sync: {
		peers(): Promise<Result<PeerSnapshot[], DaemonError>>;
	};
};
