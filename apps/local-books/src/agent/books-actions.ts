/**
 * The action surface the Local Books daemon advertises to the client agent loop
 * (ADR-0047). The daemon holds the QuickBooks mirror and runs these; the client
 * dispatches them as tools.
 *
 * Two tools today:
 * - `books_sql_query` (read): open read-only SQL over the mirror, auto-approved.
 * - `recategorize_expense` (write): the one QuickBooks write-back, gated by the
 *   loop's synchronous approval pause. Available only when the daemon was given
 *   a way to open a QuickBooks client (`openQb`); otherwise it returns a clear
 *   "unavailable" error and the read tool still works.
 */

import { defineActions } from '@epicenter/workspace';
import { createBooksQueryAction } from './books-query.ts';
import type { OpenQbClient } from './qb-access.ts';
import { createRecategorizeAction } from './recategorize.ts';

/** Build the daemon's served actions over the mirror at `dbPath`. */
export function createBooksAgentActions({
	dbPath,
	openQb,
	now = () => Date.now(),
}: {
	dbPath: string;
	/** Opens a write-capable QuickBooks client; omit for a read-only daemon. */
	openQb?: OpenQbClient;
	/** Clock for the mirror write-back timestamp; injectable for tests. */
	now?: () => number;
}) {
	return defineActions({
		books_sql_query: createBooksQueryAction({ dbPath }),
		recategorize_expense: createRecategorizeAction({ openQb, dbPath, now }),
	});
}
