/**
 * FTS5 search query for materialized SQLite tables.
 *
 * Two consumers share this function: the daemon-side materializer
 * (`sqlite.ts`) and the script-side reader (`client/attach-sqlite-reader.ts`).
 * Source-of-truth motivation: the SELECT shape (snippet format, rank
 * field, JOIN against the base table by rowid) is one project decision.
 * If we change the snippet markers or the result schema, both consumers
 * must change in lockstep, so the function lives in one place.
 *
 * The DDL that creates the FTS5 virtual table and triggers is NOT here;
 * it lives inline in `sqlite.ts` (the only writer). DDL is the
 * materializer's setup contract, not a shared rule.
 *
 * @module
 */

import type { Database } from 'bun:sqlite';
import type { Logger } from 'wellcrafted/logger';
import { quoteIdentifier } from './ddl.js';
import { AttachSqliteError } from '../attach-sqlite.js';
import type { SearchOptions, SearchResult } from './types.js';

/**
 * Execute a FTS5 search query against a materialized table.
 *
 * Returns ranked results with snippet text. The query is trimmed and
 * empty queries return an empty array. If the FTS table doesn't exist
 * or the query fails, returns an empty array with a warning.
 *
 * @param db - The mirror database to query
 * @param tableName - The source table name (FTS table is `{tableName}_fts`)
 * @param ftsColumns - The columns indexed in FTS5 (needed for snippet column index)
 * @param query - The FTS5 search query string
 * @param options - Optional search configuration (limit, snippet column)
 * @returns Array of search results sorted by relevance
 */
export function ftsSearch(
	db: Database,
	tableName: string,
	ftsColumns: string[],
	query: string,
	options?: SearchOptions,
	log?: Logger,
): SearchResult[] {
	const trimmed = query.trim();
	if (!trimmed) {
		return [];
	}

	const ftsTableName = `${tableName}_fts`;
	const limit = options?.limit ?? 50;
	const snippetColumnIndex = options?.snippetColumn
		? Math.max(ftsColumns.indexOf(options.snippetColumn), 0)
		: 0;

	try {
		const qt = quoteIdentifier(tableName);
		const qfts = quoteIdentifier(ftsTableName);
		// `db.query()` caches the compiled statement keyed by SQL text, so
		// subsequent searches for the same (tableName, snippetColumnIndex)
		// pair reuse the bytecode.
		const rows = db
			.query(
				`SELECT ${qt}.${quoteIdentifier('id')} AS id,\n` +
					`  snippet(${qfts}, ${snippetColumnIndex}, '<mark>', '</mark>', '...', 64) AS snippet,\n` +
					`  rank\n` +
					`FROM ${qfts}\n` +
					`JOIN ${qt} ON ${qt}.rowid = ${qfts}.rowid\n` +
					`WHERE ${qfts} MATCH ?\n` +
					`ORDER BY rank LIMIT ?`,
			)
			.all(trimmed, limit);

		return rows.map((row) => {
			const r = row as Record<string, unknown>;
			return {
				id: String(r.id),
				snippet: String(r.snippet ?? ''),
				rank: Number(r.rank ?? 0),
			};
		});
	} catch (cause: unknown) {
		log?.warn(
			AttachSqliteError.FtsSearchFailed({ tableName, query: trimmed, cause }),
		);
		return [];
	}
}
