/**
 * Read-only handle on the daemon's materialized SQLite mirror file.
 *
 * `attachSqlite` runs on the daemon side and writes the mirror
 * in WAL journal mode (one writer, many readers, MVCC snapshots). Script
 * peers open the same file via `attachSqliteReader({ filePath })`, get a
 * read-only `Database` handle plus an FTS5 `search()` helper symmetric
 * with the writer's, and skip the cold-start cost of computing the index
 * themselves.
 *
 * Output handle:
 *   { db, search(table, query, opts?), [Symbol.dispose]() }
 *
 * `db` is a `bun:sqlite` `Database` opened with `{ readonly: true }` and
 * `PRAGMA query_only = ON`, so any errant write attempt fails fast at the
 * driver. Wrapping it in Drizzle (`drizzle(mirror.db, { schema })`) is the
 * per-app peer factory's job; this primitive intentionally stays narrow.
 *
 * The mirror does not observe schema changes or ydoc state. It is a thin
 * wrapper around an on-disk file the daemon owns; if the daemon hasn't
 * created the file yet, opening throws and the script can decide whether
 * to retry, fall back to the synced Y.Doc, or surface the error.
 */

import { Database } from 'bun:sqlite';
import { quoteIdentifier } from './sqlite/ddl.js';
import { ftsSearch } from './sqlite/fts.js';
import type {
	SearchOptions,
	SearchResult,
} from './sqlite/types.js';

/**
 * Options for {@link attachSqliteReader}.
 */
export type AttachSqliteReaderOptions = {
	/**
	 * Absolute path to the daemon's mirror SQLite file. Typically
	 * `sqlitePath(projectDir, ydoc.guid)`.
	 */
	filePath: string;
};

/**
 * Read-only handle on the daemon's materialized SQLite mirror.
 *
 * Returned by {@link attachSqliteReader}. Disposable via the
 * explicit-resource-management protocol: declare with
 * `using reader = attachSqliteReader(...)` and the underlying database
 * handle closes on scope exit.
 */
export type SqliteReaderAttachment = {
	/**
	 * The opened SQLite database handle. Read-only; `query_only` PRAGMA is
	 * set so accidental writes fail at the driver layer.
	 */
	readonly db: Database;
	/**
	 * Run an FTS5 search against the materialized `<table>_fts` virtual
	 * table. Returns ranked results with snippets. Returns an empty array
	 * if the FTS table is missing or the query is empty.
	 */
	search(
		tableName: string,
		query: string,
		options?: SearchOptions,
	): SearchResult[];
	/** Close the database handle. Idempotent. */
	[Symbol.dispose](): void;
};

/**
 * Open the daemon's SQLite mirror file read-only.
 *
 * The mirror is opened with `{ readonly: true }`; we additionally execute
 * `PRAGMA query_only = ON` so any unintentional write inside a
 * caller-supplied raw SQL string fails. Reads run against WAL snapshot
 * pages without blocking the daemon's writes.
 *
 * @example
 * ```ts
 * using reader = attachSqliteReader({
 *   filePath: sqlitePath(projectDir, fuji.ydoc.guid),
 * });
 * const hits = reader.search('entries', 'hello world', { limit: 25 });
 * const drizzleDb = drizzle(reader.db, { schema });
 * ```
 */
export function attachSqliteReader({
	filePath,
}: AttachSqliteReaderOptions): SqliteReaderAttachment {
	const db = new Database(filePath, { readonly: true });
	db.run('PRAGMA query_only = ON');
	// Wait up to 5s on SQLITE_BUSY when a reader opens during a checkpoint
	// instead of surfacing the error to callers. The writer
	// (`attachSqlite`) sets the same value.
	db.run('PRAGMA busy_timeout = 5000');

	let isDisposed = false;

	const ftsColumnsCache = new Map<string, string[]>();
	function ftsColumnsFor(tableName: string): string[] {
		const cached = ftsColumnsCache.get(tableName);
		if (cached !== undefined) return cached;
		// `PRAGMA table_info(<tablename>_fts)` exposes the FTS5 column list
		// in declaration order. Defaults to an empty list if the FTS table
		// does not exist (the search call below will then short-circuit).
		const rows = db
			.query(`PRAGMA table_info(${quoteIdentifier(`${tableName}_fts`)})`)
			.all() as Array<{ name: string }>;
		const columns = rows.map((row) => row.name);
		ftsColumnsCache.set(tableName, columns);
		return columns;
	}

	function search(
		tableName: string,
		query: string,
		options?: SearchOptions,
	): SearchResult[] {
		if (isDisposed) return [];
		const ftsColumns = ftsColumnsFor(tableName);
		if (ftsColumns.length === 0) return [];
		return ftsSearch(db, tableName, ftsColumns, query, options);
	}

	function dispose() {
		if (isDisposed) return;
		isDisposed = true;
		db.close();
	}

	return {
		db,
		search,
		[Symbol.dispose]: dispose,
	};
}

