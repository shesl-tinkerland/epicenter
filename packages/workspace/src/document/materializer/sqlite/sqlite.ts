/**
 * SQLite materializer — mirrors workspace table rows into queryable SQLite tables.
 *
 * `attachSqliteMaterializer(ydoc, { db })` returns a chainable builder where
 * `.table(tableRef, config?)` opts in per table. Nothing materializes by default.
 *
 * Teardown is hooked to the ydoc via `ydoc.once('destroy', ...)` — callers
 * never call a dispose method; destroying the ydoc cascades.
 *
 * @module
 */

import type { StandardJSONSchemaV1 } from '@standard-schema/spec';
import Type from 'typebox';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import type * as Y from 'yjs';
import { defineMutation, defineQuery } from '../../../shared/actions.js';
import { createLogger, type Logger } from 'wellcrafted/logger';
import { standardSchemaToJsonSchema } from '../../../shared/standard-schema.js';
import type { BaseRow, Table, TableDefinition } from '../../attach-table.js';
import { generateDdl, quoteIdentifier } from './ddl.js';
import { ftsSearch, setupFtsTable } from './fts.js';
import type { MirrorDatabase, SearchOptions, SearchResult } from './types.js';

// biome-ignore lint/suspicious/noExplicitAny: generic bound for heterogeneous table helpers
type AnyTable = Table<any>;

/** Errors surfaced by the SQLite materializer's async background sync loop. */
export const SqliteMaterializerError = defineErrors({
	/** Debounced flush of pending row writes to the mirror database failed. */
	SyncFailed: ({ cause }: { cause: unknown }) => ({
		message: `[attachSqliteMaterializer] Failed to sync SQLite materializer: ${extractErrorMessage(cause)}`,
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
 * const idb = attachIndexedDb(ydoc);
 *
 * const sqlite = attachSqliteMaterializer(ydoc, {
 *   db: new Database('workspace.db'),
 *   waitFor: idb.whenLoaded,
 * })
 *   .table(tables.posts, { fts: ['title', 'body'] })
 *   .table(tables.users);
 * ```
 */
export function attachSqliteMaterializer(
	ydoc: Y.Doc,
	{
		db,
		debounceMs = 100,
		waitFor,
		log = createLogger('attachSqliteMaterializer'),
	}: {
		db: MirrorDatabase;
		debounceMs?: number;
		/**
		 * Gate: the materializer awaits this before the initial DDL + full-load.
		 * Matches the `waitFor` convention used by `attachSync`. Omit for no gate.
		 */
		waitFor?: Promise<unknown>;
		/**
		 * Logger for background failures (debounced sync flush, FTS query).
		 * Defaults to a console-backed logger with source `attachSqliteMaterializer`.
		 */
		log?: Logger;
	},
) {
	const registered = new Map<string, RegisteredTable>();
	let pendingSync = new Map<string, Set<string>>();
	let syncTimeout: ReturnType<typeof setTimeout> | null = null;
	let syncQueue = Promise.resolve();
	let isDisposed = false;
	/**
	 * Closed once `initialize()` commits (past `await waitFor`). Any `.table()`
	 * call after this throws — the materializer is past the point where late
	 * registrations would be picked up for DDL + full-load.
	 */
	let isRegistrationOpen = true;

	// ── SQL primitives ───────────────────────────────────────────

	async function insertRow(tableName: string, row: BaseRow) {
		const config = registered.get(tableName)?.config;
		const serialize = config?.serialize ?? serializeValue;
		const keys = Object.keys(row);
		const placeholders = keys.map(() => '?').join(', ');
		const values = keys.map((key) => serialize(row[key]));
		const columns = keys.map(quoteIdentifier).join(', ');

		const stmt = await db.prepare(
			`INSERT OR REPLACE INTO ${quoteIdentifier(tableName)} (${columns}) VALUES (${placeholders})`,
		);
		await stmt.run(...values);
	}

	async function deleteRow(tableName: string, id: string) {
		const stmt = await db.prepare(
			`DELETE FROM ${quoteIdentifier(tableName)} WHERE ${quoteIdentifier('id')} = ?`,
		);
		await stmt.run(id);
	}

	async function fullLoadTable(tableName: string, table: AnyTable) {
		const config = registered.get(tableName)?.config;
		const serialize = config?.serialize ?? serializeValue;
		const rows = table.getAllValid();
		if (rows.length === 0) return;

		const keys = Object.keys(rows[0]!);
		const placeholders = keys.map(() => '?').join(', ');
		const columns = keys.map(quoteIdentifier).join(', ');
		const stmt = await db.prepare(
			`INSERT OR REPLACE INTO ${quoteIdentifier(tableName)} (${columns}) VALUES (${placeholders})`,
		);

		for (const row of rows) {
			const values = keys.map((key) => serialize(row[key]));
			await stmt.run(...values);
		}
	}

	// ── Sync engine ──────────────────────────────────────────────

	function scheduleSync(tableName: string, changedIds: ReadonlySet<string>) {
		if (isDisposed) return;

		let tableIds = pendingSync.get(tableName);
		if (tableIds === undefined) {
			tableIds = new Set<string>();
			pendingSync.set(tableName, tableIds);
		}

		for (const id of changedIds) tableIds.add(id);

		if (syncTimeout !== null) clearTimeout(syncTimeout);

		syncTimeout = setTimeout(() => {
			syncTimeout = null;
			syncQueue = syncQueue
				.then(() => flushPendingSync())
				.catch((cause: unknown) => {
					log.error(SqliteMaterializerError.SyncFailed({ cause }));
				});
		}, debounceMs);
	}

	async function flushPendingSync() {
		if (isDisposed) return;

		const currentPending = pendingSync;
		pendingSync = new Map<string, Set<string>>();

		for (const [tableName, ids] of currentPending) {
			const entry = registered.get(tableName);
			if (entry === undefined) continue;

			for (const id of ids) {
				const { data: row, error } = entry.table.get(id);
				if (error || row === null) {
					// Invalid or missing → drop from mirror.
					await deleteRow(tableName, id);
					continue;
				}
				await insertRow(tableName, row);
			}
		}
	}

	// ── Query / mutation surface ─────────────────────────────────

	async function search(
		tableName: string,
		query: string,
		options?: SearchOptions,
	): Promise<SearchResult[]> {
		if (isDisposed) return [];
		const entry = registered.get(tableName);
		const ftsColumns = entry?.config.fts;
		if (ftsColumns === undefined || ftsColumns.length === 0) return [];
		return ftsSearch(db, tableName, ftsColumns, query, options, log);
	}

	async function count(tableName: string): Promise<number> {
		if (isDisposed) return 0;
		try {
			const stmt = await db.prepare(
				`SELECT COUNT(*) AS count FROM ${quoteIdentifier(tableName)}`,
			);
			const row = (await stmt.get()) as Record<string, unknown> | null;
			return Number(row?.count ?? 0);
		} catch {
			return 0;
		}
	}

	async function rebuild(tableName?: string): Promise<void> {
		if (isDisposed) return;

		if (tableName !== undefined) {
			const entry = registered.get(tableName);
			if (entry === undefined) {
				throw new Error(
					`Cannot rebuild "${tableName}" — not in the materialized table set.`,
				);
			}
			await db.run('BEGIN');
			try {
				await db.run(`DELETE FROM ${quoteIdentifier(tableName)}`);
				await fullLoadTable(tableName, entry.table);
				await db.run('COMMIT');
			} catch (error: unknown) {
				await db.run('ROLLBACK');
				throw error;
			}
			return;
		}

		await db.run('BEGIN');
		try {
			for (const [name] of registered)
				await db.run(`DELETE FROM ${quoteIdentifier(name)}`);
			for (const [name, entry] of registered)
				await fullLoadTable(name, entry.table);
			await db.run('COMMIT');
		} catch (error: unknown) {
			await db.run('ROLLBACK');
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
		if (syncTimeout !== null) {
			clearTimeout(syncTimeout);
			syncTimeout = null;
		}
		for (const entry of registered.values()) entry.unsubscribe?.();
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
			await db.run(generateDdl(tableName, jsonSchema));
			if (entry.config.fts && entry.config.fts.length > 0)
				await setupFtsTable(db, tableName, entry.config.fts);
		}

		if (isDisposed) return;

		await db.run('BEGIN');
		try {
			for (const [tableName, entry] of registered)
				await fullLoadTable(tableName, entry.table);
			await db.run('COMMIT');
		} catch (error: unknown) {
			await db.run('ROLLBACK');
			throw error;
		}

		if (isDisposed) return;

		for (const [tableName, entry] of registered) {
			entry.unsubscribe = entry.table.observe((changedIds) => {
				scheduleSync(tableName, changedIds);
			});
		}
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
