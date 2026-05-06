/**
 * SQLite materializer: mirrors workspace table rows into queryable SQLite tables.
 *
 * `attachSqlite(ydoc, { filePath })` returns a chainable builder
 * where `.table(tableRef, config?)` opts in per table. Nothing materializes
 * by default. The materializer owns the `Database` lifecycle: it opens the
 * file (mkdir + WAL pragma) at construction and closes it on `ydoc.destroy()`.
 *
 * Pass `filePath: ':memory:'` for tests; otherwise pass a real on-disk path
 * (typically `sqlitePath(projectDir, ydoc.guid)`). bun:sqlite is the only driver.
 *
 * @module
 */

import type { Database } from 'bun:sqlite';
import type { StandardJSONSchemaV1 } from '@standard-schema/spec';
import Type from 'typebox';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { createLogger, type Logger } from 'wellcrafted/logger';
import type * as Y from 'yjs';
import { defineMutation, defineQuery } from '../shared/actions.js';
import { standardSchemaToJsonSchema } from '../shared/standard-schema.js';
import { openWriterSqlite } from './sqlite-writer.js';
import type { BaseRow, Table, TableDefinition } from './attach-table.js';
import { generateDdl, quoteIdentifier } from './sqlite/ddl.js';
import { ftsSearch } from './sqlite/fts.js';
import type { SearchOptions, SearchResult } from './sqlite/types.js';

export { generateDdl } from './sqlite/ddl.js';
export type { SearchOptions, SearchResult } from './sqlite/types.js';

// biome-ignore lint/suspicious/noExplicitAny: generic bound for heterogeneous table helpers
type AnyTable = Table<any>;

/** Errors surfaced by the SQLite materializer's async background sync loop. */
export const AttachSqliteError = defineErrors({
	/** Per-transact flush of pending row writes to the mirror database failed. */
	SyncFailed: ({ cause }: { cause: unknown }) => ({
		message: `[attachSqlite] Failed to sync SQLite materializer: ${extractErrorMessage(cause)}`,
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
		message: `[attachSqlite] FTS search failed on table "${tableName}" for query "${query}": ${extractErrorMessage(cause)}`,
		tableName,
		query,
		cause,
	}),
});
export type AttachSqliteError = InferErrors<typeof AttachSqliteError>;

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
	// biome-ignore lint/suspicious/noExplicitAny: internal storage: variance across heterogeneous row types
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
 * const sqlite = attachSqlite(ydoc, {
 *   filePath: sqlitePath(projectDir, ydoc.guid),
 *   waitFor: idb.whenLoaded,
 * })
 *   .table(tables.posts, { fts: ['title', 'body'] })
 *   .table(tables.users);
 * ```
 */
export function attachSqlite(
	ydoc: Y.Doc,
	{
		filePath,
		waitFor,
		log = createLogger('attachSqlite'),
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
		 * Defaults to a console-backed logger with source `attachSqlite`.
		 */
		log?: Logger;
	},
) {
	const db = openWriterSqlite({ filePath, log });

	const registered = new Map<string, RegisteredTable>();
	let pendingSync = new Map<string, Set<string>>();
	let syncQueue = Promise.resolve();
	let isDisposed = false;
	/**
	 * Closed once `initialize()` commits (past `await waitFor`). Any `.table()`
	 * call after this throws: the materializer is past the point where late
	 * registrations would be picked up for DDL + full-load.
	 */
	let isRegistrationOpen = true;

	// ── SQL primitives ───────────────────────────────────────────

	// `db.query()` caches the compiled prepared statement on the Database
	// keyed by SQL text, so re-issuing the same INSERT/DELETE inside a tight
	// flush loop reuses the cached bytecode. `db.prepare()` would compile
	// fresh each call.

	function insertRow(tableName: string, row: BaseRow) {
		const config = registered.get(tableName)?.config;
		const serialize = config?.serialize ?? serializeValue;
		const keys = Object.keys(row);
		const placeholders = keys.map(() => '?').join(', ');
		const values = keys.map((key) => serialize(row[key]));
		const columns = keys.map(quoteIdentifier).join(', ');

		db.query(
			`INSERT OR REPLACE INTO ${quoteIdentifier(tableName)} (${columns}) VALUES (${placeholders})`,
		).run(...(values as never[]));
	}

	function deleteRow(tableName: string, id: string) {
		db.query(
			`DELETE FROM ${quoteIdentifier(tableName)} WHERE ${quoteIdentifier('id')} = ?`,
		).run(id);
	}

	function fullLoadTable(tableName: string, table: AnyTable) {
		const config = registered.get(tableName)?.config;
		const serialize = config?.serialize ?? serializeValue;
		const rows = table.getAllValid();
		if (rows.length === 0) return;

		const keys = Object.keys(rows[0]!);
		const placeholders = keys.map(() => '?').join(', ');
		const columns = keys.map(quoteIdentifier).join(', ');
		const stmt = db.query(
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
				log.error(AttachSqliteError.SyncFailed({ cause }));
			});
	}

	// One Yjs transact = one SQL transaction. `db.transaction()` auto-begins,
	// auto-commits on return, and auto-rolls-back on throw, replacing a
	// manual BEGIN/COMMIT/ROLLBACK block with no recovery branch needed.
	const flushTx = db.transaction(
		(currentPending: Map<string, Set<string>>) => {
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
		},
	);

	function flushPendingSync() {
		if (isDisposed) return;
		if (pendingSync.size === 0) return;

		const currentPending = pendingSync;
		pendingSync = new Map<string, Set<string>>();

		flushTx(currentPending);
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
		if (!registered.has(tableName)) {
			throw new Error(
				`Cannot count "${tableName}": not in the materialized table set.`,
			);
		}
		const row = db
			.query(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(tableName)}`)
			.get() as { count: number };
		return row.count;
	}

	const rebuildOneTx = db.transaction((name: string, table: AnyTable) => {
		db.run(`DELETE FROM ${quoteIdentifier(name)}`);
		fullLoadTable(name, table);
	});

	const rebuildAllTx = db.transaction(() => {
		for (const [name] of registered)
			db.run(`DELETE FROM ${quoteIdentifier(name)}`);
		for (const [name, entry] of registered)
			fullLoadTable(name, entry.table);
	});

	function rebuild(tableName?: string): void {
		if (isDisposed) return;

		if (tableName !== undefined) {
			const entry = registered.get(tableName);
			if (entry === undefined) {
				throw new Error(
					`Cannot rebuild "${tableName}": not in the materialized table set.`,
				);
			}
			rebuildOneTx(tableName, entry.table);
			return;
		}

		rebuildAllTx();
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

		for (const [tableName, entry] of registered) {
			const jsonSchema = tableDefinitionToJsonSchema(
				entry.table.definition,
				tableName,
			);
			db.run(generateDdl(tableName, jsonSchema));
			if (entry.config.fts && entry.config.fts.length > 0)
				createFtsTable(db, tableName, entry.config.fts);
		}

		if (isDisposed) return;

		const initialFullLoadTx = db.transaction(() => {
			for (const [tableName, entry] of registered)
				fullLoadTable(tableName, entry.table);
		});
		initialFullLoadTx();

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

	const whenLoaded = initialize();

	// ── Builder ──────────────────────────────────────────────────

	const api = {
		whenLoaded,
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
		 * Must be called synchronously after construction, before `whenLoaded`
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
					`attachSqlite: .table("${table.name}") called after initial flush. All .table() registrations must happen synchronously after construction.`,
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

/**
 * Create the `<table>_fts` virtual table and the three triggers that keep
 * it synchronized with the materialized base table (insert, delete,
 * update). Only the materializer's initial DDL pass calls this; the
 * triggers do all the work after that.
 */
function createFtsTable(
	db: Database,
	tableName: string,
	columns: string[],
): void {
	const ftsTableName = `${tableName}_fts`;
	const quotedColumns = columns.map(quoteIdentifier).join(', ');
	const newValues = columns
		.map((column) => `new.${quoteIdentifier(column)}`)
		.join(', ');
	const oldValues = columns
		.map((column) => `old.${quoteIdentifier(column)}`)
		.join(', ');

	const qt = quoteIdentifier(tableName);
	const qfts = quoteIdentifier(ftsTableName);

	db.run(
		`CREATE VIRTUAL TABLE IF NOT EXISTS ${qfts}\n` +
			`USING fts5(${quotedColumns}, content=${quoteSqlString(tableName)}, content_rowid=rowid)`,
	);

	db.run(
		`CREATE TRIGGER IF NOT EXISTS ${quoteIdentifier(`${tableName}_fts_ai`)}\n` +
			`AFTER INSERT ON ${qt} BEGIN\n` +
			`  INSERT INTO ${qfts}(rowid, ${quotedColumns})\n` +
			`  VALUES (new.rowid, ${newValues});\n` +
			`END`,
	);

	db.run(
		`CREATE TRIGGER IF NOT EXISTS ${quoteIdentifier(`${tableName}_fts_ad`)}\n` +
			`AFTER DELETE ON ${qt} BEGIN\n` +
			`  INSERT INTO ${qfts}(${qfts}, rowid, ${quotedColumns})\n` +
			`  VALUES('delete', old.rowid, ${oldValues});\n` +
			`END`,
	);

	db.run(
		`CREATE TRIGGER IF NOT EXISTS ${quoteIdentifier(`${tableName}_fts_au`)}\n` +
			`AFTER UPDATE ON ${qt} BEGIN\n` +
			`  INSERT INTO ${qfts}(${qfts}, rowid, ${quotedColumns})\n` +
			`  VALUES('delete', old.rowid, ${oldValues});\n` +
			`  INSERT INTO ${qfts}(rowid, ${quotedColumns})\n` +
			`  VALUES (new.rowid, ${newValues});\n` +
			`END`,
	);
}

function quoteSqlString(value: string): string {
	return `'${value.replaceAll("'", "''")}'`;
}

function tableDefinitionToJsonSchema(
	// biome-ignore lint/suspicious/noExplicitAny: variance-friendly: defineTable already constrains schemas
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
