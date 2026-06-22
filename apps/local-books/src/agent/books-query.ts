/**
 * `books_sql_query`: the read-only SQL tool the agent reaches as a dispatched
 * action (ADR-0047). The Local Books daemon holds the QuickBooks mirror (SQLite)
 * and runs this action; the client agent loop dispatches it and feeds the rows
 * back into the turn. The data leaves the machine only as a tool result, the
 * egress ADR-0033 already accepts.
 *
 * It is a `query` (auto-approved): a read-only connection is the enforcement, not
 * a string check. `new Database(path, { readonly: true })` makes SQLite reject
 * any write statement, so the model cannot mutate the mirror through this tool
 * even though it passes raw SQL. Results are row-capped so a broad query cannot
 * flood the model's context.
 */

import { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import { defineQuery } from '@epicenter/workspace';
import { Type } from 'typebox';
import { defineErrors, extractErrorMessage } from 'wellcrafted/error';
import { Ok } from 'wellcrafted/result';

export const BooksQueryError = defineErrors({
	NoMirror: ({ path }: { path: string }) => ({
		message: `No QuickBooks mirror at ${path}. Run \`local-books sync\` first.`,
	}),
	QueryFailed: ({ cause }: { cause: unknown }) => ({
		message: `Read-only query failed (the mirror rejects writes): ${extractErrorMessage(cause)}`,
		cause,
	}),
});

/** Cap returned rows so a broad query cannot flood the model's context. */
const MAX_ROWS = 1000;

/**
 * Build the `books_sql_query` action over the mirror at `dbPath`. The handle is
 * opened read-only per call (cheap, and it sidesteps holding a lock while sync
 * writes), so the daemon can serve queries while `local-books sync` runs.
 */
export function createBooksQueryAction({ dbPath }: { dbPath: string }) {
	return defineQuery({
		title: 'Query the books',
		description:
			'Run a read-only SQL query against the local QuickBooks mirror (SQLite). ' +
			'Tables: invoices, customers, items, payments, bills, vendors, accounts, ' +
			'purchases (expenses), deposits. Each row has id, raw (verbatim QB JSON), ' +
			'updated_at, synced_at, deleted, plus a few extracted scalar columns; the ' +
			"line-level category lives in raw (e.g. json_extract(raw, '$.Line')). " +
			'Filter `deleted = 0` for live rows. SELECT only; writes are rejected.',
		input: Type.Object({
			sql: Type.String({
				description: 'A read-only SQL query (SELECT / WITH / PRAGMA).',
			}),
		}),
		handler: ({ sql }) => {
			if (!existsSync(dbPath))
				return BooksQueryError.NoMirror({ path: dbPath });
			const db = new Database(dbPath, { readonly: true });
			try {
				const rows = db.query(sql).all() as Record<string, unknown>[];
				const truncated = rows.length > MAX_ROWS;
				return Ok({
					rows: truncated ? rows.slice(0, MAX_ROWS) : rows,
					rowCount: rows.length,
					truncated,
				});
			} catch (cause) {
				return BooksQueryError.QueryFailed({ cause });
			} finally {
				db.close();
			}
		},
	});
}
