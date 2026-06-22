/**
 * The action surface the Local Books daemon advertises to the client agent loop
 * (ADR-0047). The daemon holds the QuickBooks mirror and runs these; the client
 * dispatches them as tools.
 *
 * Today it is the read-only `books_sql_query`. The write tools the mirror needs
 * an overlay table for (`mark_reviewed`, `add_note`) are the next increment;
 * they land here beside the query, gated by the synchronous approval pause.
 */

import { defineActions } from '@epicenter/workspace';
import { createBooksQueryAction } from './books-query.ts';

/** Build the daemon's served actions over the mirror at `dbPath`. */
export function createBooksAgentActions({ dbPath }: { dbPath: string }) {
	return defineActions({
		books_sql_query: createBooksQueryAction({ dbPath }),
	});
}
