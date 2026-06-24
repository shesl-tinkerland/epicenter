/**
 * The action surface the Local Books daemon advertises to the client agent loop
 * (ADR-0047). The daemon holds the QuickBooks mirror and runs these; the client
 * dispatches them as tools.
 *
 * The advertised tools are a capability lattice, so the agent is only offered
 * what the daemon can actually do (it never sees a tool it cannot use):
 *
 * - `books_sql_query` (read, local mirror): always. Needs no QuickBooks client.
 * - `books_report` (read, live QuickBooks): when a QuickBooks client is available
 *   (`openQb`). Omitting `openQb` is a fully-offline, mirror-only daemon.
 * - `recategorize_expense` (write, QuickBooks): when a client is available AND
 *   the daemon is not read-only. `readOnly` withholds the write while keeping
 *   both reads, the safety posture of "analyze my books, don't mutate them".
 *
 * Local annotation tools (`mark_reviewed`, `add_note`) over an overlay table
 * remain parked in the spec.
 */

import { defineActions } from '@epicenter/workspace';
import { createBooksQueryAction } from './books-query.ts';
import type { OpenQbClient } from './qb-access.ts';
import { createRecategorizeAction } from './recategorize.ts';
import { createReportAction } from './report.ts';

/** Build the daemon's served actions over the mirror at `dbPath`. */
export function createBooksAgentActions({
	dbPath,
	openQb,
	readOnly = false,
	now = () => Date.now(),
}: {
	dbPath: string;
	/** Opens a QuickBooks client; omit for a fully-offline, mirror-only daemon. */
	openQb?: OpenQbClient;
	/** Withhold the write tool while keeping both reads. */
	readOnly?: boolean;
	/** Clock for the mirror write-back timestamp; injectable for tests. */
	now?: () => number;
}) {
	const books_sql_query = createBooksQueryAction({ dbPath });
	if (!openQb) return defineActions({ books_sql_query });

	const books_report = createReportAction({ openQb });
	if (readOnly) return defineActions({ books_sql_query, books_report });

	return defineActions({
		books_sql_query,
		books_report,
		recategorize_expense: createRecategorizeAction({ openQb, dbPath, now }),
	});
}
