/**
 * SQLite materializer — mirrors workspace table rows into queryable SQLite tables.
 *
 * `attachSqliteMaterializer(ydoc, { filePath })` returns a chainable builder
 * where `.table(tableRef, config?)` opts in per table. Nothing materializes
 * by default. The materializer owns the `Database` lifecycle: it opens the
 * file (mkdir + WAL pragma) at construction and closes it on `ydoc.destroy()`.
 *
 * Pass `filePath: ':memory:'` for tests; otherwise pass a real on-disk path
 * (typically `sqlitePath(absDir, ydoc.guid)`). bun:sqlite is the only driver.
 *
 * @module
 */

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { Database } from 'bun:sqlite';
import type { StandardJSONSchemaV1 } from '@standard-schema/spec';
import Type from 'typebox';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { trySync } from 'wellcrafted/result';
import { createLogger, type Logger } from 'wellcrafted/logger';
import type * as Y from 'yjs';
import { defineMutation, defineQuery } from '../../../shared/actions.js';
import { standardSchemaToJsonSchema } from '../../../shared/standard-schema.js';
import type { BaseRow, Table, TableDefinition } from '../../attach-table.js';
import { generateDdl, quoteIdentifier } from './ddl.js';
import { ftsSearch, setupFtsTable } from './fts.js';
import type { SearchOptions, SearchResult } from './types.js';

// biome-ignore lint/suspicious/noExplicitAny: generic bound for heterogeneous table helpers
type AnyTable = Table<any>;

/** Errors surfaced by the SQLite materializer's async background sync loop. */
export const SqliteMaterializerError = defineErrors({
	/** Per-transact flush of pending row writes to the mirror database failed. */
	SyncFailed: ({ cause }: { cause: unknown }) => ({
		message: `[attachSqliteMaterializer] Failed to sync SQLite materializer: ${extractErrorMessage(cause)}`,
		cause,
	}),
	/**
	 * Setting `PRAGMA journal_mode = WAL` failed. Non-fatal: `:memory:` and
	 * some test setups do not honor the pragma. The materializer proceeds
	 * with the driver default. Production daemons should always run on a
	 * real on-disk file where WAL is supported, since peer-side
	 * `attachSqliteMirror` relies on WAL for concurrent reads.
	 */
	WalPragmaFailed: ({ cause }: { cause: unknown }) => ({
		message: `[attachSqliteMaterializer] Failed to enable WAL journal mode: ${extractErrorMessage(cause)}`,
		cause,
	}),
	/** An FTS5 MATCH query raised inside the mirror database. */
	FtsSearchFailed: ({
		tableName,
		query,
		cause,
	}: {
		tableName: string;
		query: string;
		cause: unknown;
	}) => ({
		message: `[attachSqliteMaterializer] FTS search failed on table "${tableName}" for query "${query}": ${extractErrorMessage(cause)}`,
		tableName,
		query,
		cause,
	}),
});
export type SqliteMaterializerError = InferErrors<typeof SqliteMaterializerError>;

/**
 * Per-table configuration, generic over the specific row type so `fts` narrows
 * to valid column names at the call site.
 */
type TableConfig<TRow extends BaseRow> = {
	/** Column names to include in FTS5 full-text search index. */
	fts?: (keyof TRow & string)[];
	/** Optional per-column value serializer override. */
	serialize?: (value: unknown) => unknown;
};

type RegisteredTable = {
	table: AnyTable;
	// biome-ignore lint/suspicious/noExplicitAny: internal storage — variance across heterogeneous row types
	config: TableConfig<any>;
	unsubscribe?: () => void;
};

/**
 * Create a one-way materializer that mirrors workspace table rows into SQLite.
 *
 * @example
 * ```ts
 * const ydoc = new Y.Doc({ guid: 'workspace' });
 * const tables = attachTables(ydoc, myTableDefs);
 *
 * const sqlite = attachSqliteMaterializer(ydoc, {
 *   filePath: sqlitePath(absDir, ydoc.guid),
 *   waitFor: persistence.whenLoaded,
 * })
 *   .table(tables.posts, { fts: ['title', 'body'] })
 *   .table(tables.users);
 * ```
 */
export function attachSqliteMaterializer(
	ydoc: Y.Doc,
	{
		filePath,
		waitFor,
		log = createLogger('attachSqliteMaterializer'),
	}: {
		/**
		 * Path to the SQLite file the materializer owns. Parent dir is
		 * created; WAL is enabled; the handle is closed on `ydoc.destroy()`.
		 * Pass `':memory:'` for tests.
		 */
		filePath: string;
		/**
		 * Gate: the materializer awaits this before the initial DDL + full-load.
		 * Matches the `waitFor` convention used by `attachSync`. Omit for no gate.
		 */
		waitFor?: Promise<unknown>;
		/**
		 * Logger for background failures (per-transact sync flush, FTS query).
		 * Defaults to a console-backed logger with source `attachSqliteMaterializer`.
		 */
		log?: Logger;
	},
) {
	if (filePath !== ':memory:') {
		mkdirSync(dirname(filePath), { recursive: true });
	}
	const db = new Database(filePath);

	const registered = new Map<string, RegisteredTable>();
	let pendingSync = new Map<string, Set<string>>();
	let syncQueue = Promise.resolve();
	let isDisposed = false;
	/**
	 * Closed once `initialize()` commits (past `await waitFor`). Any `.table()`
	 * call after this throws — the materializer is past the point where late
	 * registrations would be picked up for DDL + full-load.
	 */
	let isRegistrationOpen = true;

	// ── SQL primitives ───────────────────────────────────────────

	function insertRow(tableName: string, row: BaseRow) {
		const config = registered.get(tableName)?.config;
		const serialize = config?.serialize ?? serializeValue;
		const keys = Object.keys(row);
		const placeholders = keys.map(() => '?').join(', ');
		const values = keys.map((key) => serialize(row[key]));
		const columns = keys.map(quoteIdentifier).join(', ');

		const stmt = db.prepare(
			`INSERT OR REPLACE INTO ${quoteIdentifier(tableName)} (${columns}) VALUES (${placeholders})`,
		);
		stmt.run(...(values as never[]));
	}

	function deleteRow(tableName: string, id: string) {
		const stmt = db.prepare(
			`DELETE FROM ${quoteIdentifier(tableName)} WHERE ${quoteIdentifier('id')} = ?`,
		);
		stmt.run(id);
	}

	function fullLoadTable(tableName: string, table: AnyTable) {
		const config = registered.get(tableName)?.config;
		const serialize = config?.serialize ?? serializeValue;
		const rows = table.getAllValid();
		if (rows.length === 0) return;

		const keys = Object.keys(rows[0]!);
		const placeholders = keys.map(() => '?').join(', ');
		const columns = keys.map(quoteIdentifier).join(', ');
		const stmt = db.prepare(
			`INSERT OR REPLACE INTO ${quoteIdentifier(tableName)} (${columns}) VALUES (${placeholders})`,
		);

		for (const row of rows) {
			const values = keys.map((key) => serialize(row[key]));
			stmt.run(...(values as never[]));
		}
	}

	// ── Sync engine ──────────────────────────────────────────────
	//
	// Per spec invariant 16: one Yjs transact = one SQL transaction. Per-table
	// observers populate `pendingSync` synchronously inside the transact's
	// observer phase; `ydoc.on('afterTransaction', ...)` then enqueues a single
	// flush on `syncQueue`. The flush wraps all pending row writes for that
	// transact in BEGIN/COMMIT, so 10k row updates inside one Yjs transact
	// produce one SQL transaction (one fsync) instead of 10k auto-commits.

	function recordPending(tableName: string, changedIds: ReadonlySet<string>) {
		if (isDisposed) return;
		let tableIds = pendingSync.get(tableName);
		if (tableIds === undefined) {
			tableIds = new Set<string>();
			pendingSync.set(tableName, tableIds);
		}
		for (const id of changedIds) tableIds.add(id);
	}

	function enqueueFlush() {
		if (isDisposed) return;
		if (pendingSync.size === 0) return;
		syncQueue = syncQueue
			.then(() => flushPendingSync())
			.catch((cause: unknown) => {
				log.error(SqliteMaterializerError.SyncFailed({ cause }));
			});
	}

	function flushPendingSync() {
		if (isDisposed) return;
		if (pendingSync.size === 0) return;

		const currentPending = pendingSync;
		pendingSync = new Map<string, Set<string>>();

		db.run('BEGIN');
		try {
			for (const [tableName, ids] of currentPending) {
				const entry = registered.get(tableName);
				if (entry === undefined) continue;

				for (const id of ids) {
					const { data: row, error } = entry.table.get(id);
					if (error || row === null) {
						// Invalid or missing → drop from mirror.
						deleteRow(tableName, id);
						continue;
					}
					insertRow(tableName, row);
				}
			}
			db.run('COMMIT');
		} catch (error: unknown) {
			try {
				db.run('ROLLBACK');
			} catch {
				// Best-effort: if ROLLBACK itself fails (e.g. txn already aborted),
				// surface the original cause, not the rollback noise.
			}
			throw error;
		}
	}

	// ── Query / mutation surface ─────────────────────────────────

	function search(
		tableName: string,
		query: string,
		options?: SearchOptions,
	): SearchResult[] {
		if (isDisposed) return [];
		const entry = registered.get(tableName);
		const ftsColumns = entry?.config.fts;
		if (ftsColumns === undefined || ftsColumns.length === 0) return [];
		return ftsSearch(db, tableName, ftsColumns, query, options, log);
	}

	function count(tableName: string): number {
		if (isDisposed) return 0;
		try {
			const stmt = db.prepare(
				`SELECT COUNT(*) AS count FROM ${quoteIdentifier(tableName)}`,
			);
			const row = stmt.get() as Record<string, unknown> | null;
			return Number(row?.count ?? 0);
		} catch {
			return 0;
		}
	}

	function rebuild(tableName?: string): void {
		if (isDisposed) return;

		if (tableName !== undefined) {
			const entry = registered.get(tableName);
			if (entry === undefined) {
				throw new Error(
					`Cannot rebuild "${tableName}" — not in the materialized table set.`,
				);
			}
			db.run('BEGIN');
			try {
				db.run(`DELETE FROM ${quoteIdentifier(tableName)}`);
				fullLoadTable(tableName, entry.table);
				db.run('COMMIT');
			} catch (error: unknown) {
				db.run('ROLLBACK');
				throw error;
			}
			return;
		}

		db.run('BEGIN');
		try {
			for (const [name] of registered)
				db.run(`DELETE FROM ${quoteIdentifier(name)}`);
			for (const [name, entry] of registered)
				fullLoadTable(name, entry.table);
			db.run('COMMIT');
		} catch (error: unknown) {
			db.run('ROLLBACK');
			throw error;
		}
	}

	// ── Disposal ────────────────────────────────────────────────

	function dispose() {
		if (isDisposed) return;
		isDisposed = true;
		// Close the registration window even if `initialize()` never ran
		// (e.g., waitFor stalled and the ydoc was destroyed before init).
		isRegistrationOpen = false;
		ydoc.off('afterTransaction', onAfterTransaction);
		for (const entry of registered.values()) entry.unsubscribe?.();
		try {
			db.close();
		} catch {
			// Best-effort close; if the db was never opened (filePath threw
			// upstream of construction) or already closed, ignore.
		}
	}

	ydoc.once('destroy', dispose);

	// ── Initial flush ────────────────────────────────────────────

	async function initialize() {
		// Always yield a microtask so callers can finish synchronous setup
		// (including writing initial rows) before the full-load runs.
		await waitFor;
		// Close the registration window: any further `.table()` call throws,
		// even if init errors or disposes mid-flight below.
		isRegistrationOpen = false;
		if (isDisposed) return;

		// Enable WAL so the script-side `attachSqliteMirror` can open the
		// same file `{ readonly: true }` and run concurrent reads against
		// snapshot pages while the daemon writes. Sequenced BEFORE DDL so
		// the journal mode is set on the file header before any CREATE TABLE
		// touches it. Failure is logged (`:memory:` always rejects) and the
		// materializer proceeds with the driver default.
		const walResult = trySync({
			try: () => db.run('PRAGMA journal_mode = WAL'),
			catch: (cause) => SqliteMaterializerError.WalPragmaFailed({ cause }),
		});
		if (walResult.error !== null) log.warn(walResult.error);
		if (isDisposed) return;

		for (const [tableName, entry] of registered) {
			const jsonSchema = tableDefinitionToJsonSchema(
				entry.table.definition,
				tableName,
			);
			db.run(generateDdl(tableName, jsonSchema));
			if (entry.config.fts && entry.config.fts.length > 0)
				setupFtsTable(db, tableName, entry.config.fts);
		}

		if (isDisposed) return;

		db.run('BEGIN');
		try {
			for (const [tableName, entry] of registered)
				fullLoadTable(tableName, entry.table);
			db.run('COMMIT');
		} catch (error: unknown) {
			db.run('ROLLBACK');
			throw error;
		}

		if (isDisposed) return;

		for (const [tableName, entry] of registered) {
			entry.unsubscribe = entry.table.observe((changedIds) => {
				recordPending(tableName, changedIds);
			});
		}
		ydoc.on('afterTransaction', onAfterTransaction);
	}

	function onAfterTransaction() {
		enqueueFlush();
	}

	const whenFlushed = initialize();

	// ── Builder ──────────────────────────────────────────────────

	const api = {
		whenFlushed,
		db,
		search: defineQuery({
			title: 'Full-text search',
			description: 'FTS5 search across materialized table rows',
			input: Type.Object({
				table: Type.String(),
				query: Type.String(),
				limit: Type.Optional(Type.Number()),
			}),
			handler: ({ table: tableName, query: q, limit: lim }) =>
				search(tableName, q, lim !== undefined ? { limit: lim } : undefined),
		}),
		count: defineQuery({
			title: 'Row count',
			description: 'Count rows in a materialized table',
			input: Type.Object({ table: Type.String() }),
			handler: ({ table: tableName }) => count(tableName),
		}),
		rebuild: defineMutation({
			title: 'Rebuild materializer',
			description: 'Drop and rebuild all materialized tables from Yjs source',
			input: Type.Object({ table: Type.Optional(Type.String()) }),
			handler: ({ table: tableName }) => rebuild(tableName),
		}),
	};

	type MaterializerBuilder = typeof api & {
		/**
		 * Opt in a workspace table for SQLite materialization.
		 *
		 * `fts` and `serialize` are narrowed to the specific row type, so typos
		 * in column names become compile errors.
		 *
		 * Must be called synchronously after construction, before `whenFlushed`
		 * resolves. Calls after the initial flush throw.
		 */
		table<TRow extends BaseRow>(
			table: Table<TRow>,
			config?: TableConfig<TRow>,
		): MaterializerBuilder;
	};

	const builder: MaterializerBuilder = {
		...api,
		table(table, config) {
			if (!isRegistrationOpen)
				throw new Error(
					`attachSqliteMaterializer: .table("${table.name}") called after initial flush. All .table() registrations must happen synchronously after construction.`,
				);
			registered.set(table.name, {
				table: table as AnyTable,
				config: config ?? {},
			});
			return builder;
		},
	};

	return builder;
}

// ════════════════════════════════════════════════════════════════════════════
// MODULE-LEVEL HELPERS
// ════════════════════════════════════════════════════════════════════════════

function tableDefinitionToJsonSchema(
	// biome-ignore lint/suspicious/noExplicitAny: variance-friendly — defineTable already constrains schemas
	definition: TableDefinition<any>,
	tableName: string,
): Record<string, unknown> {
	const schema = definition.schema;
	if (
		schema === null ||
		schema === undefined ||
		(typeof schema !== 'object' && typeof schema !== 'function') ||
		!('~standard' in schema)
	) {
		throw new Error(
			`SQLite materializer definition for "${tableName}" is not a Standard Schema (missing ~standard).`,
		);
	}
	return standardSchemaToJsonSchema(schema as StandardJSONSchemaV1);
}

/**
 * Convert a workspace row value into a SQLite-compatible value.
 *
 * - `null` / `undefined` → SQL `NULL`
 * - `object` / `array` → JSON string (`TEXT` column)
 * - `boolean` → `0` or `1` (`INTEGER` column)
 * - everything else → passed through as-is
 */
export function serializeValue(value: unknown): unknown {
	if (value === null || value === undefined) return null;
	if (typeof value === 'object') return JSON.stringify(value);
	if (typeof value === 'boolean') return value ? 1 : 0;
	return value;
}
