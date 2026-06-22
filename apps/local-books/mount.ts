/**
 * The Local Books data daemon (ADR-0047): it holds the QuickBooks mirror and
 * serves it as dispatched actions, but never runs inference. `localBooksMount()`
 * returns the `Mount` an `epicenter.config.ts` default-exports; the daemon opens
 * the same synced room the client loop drives and advertises `books_sql_query`
 * over presence. A tool call dispatches here, runs against the local SQLite, and
 * returns rows; the financial data leaves the machine only as that result.
 *
 * The mirror is the CLI's own `<dataDir>/<realmId>/books.db`. `local-books sync`
 * keeps it current; this mount only reads it.
 */

import { nodeMountRuntime } from '@epicenter/workspace/node';
import { localBooksWorkspace } from './books.ts';
import { createBooksAgentActions } from './src/agent/books-actions.ts';
import { dbPath } from './src/paths.ts';

export type LocalBooksMountOptions = {
	/** Base URL of the Epicenter cloud API used for sync. */
	baseURL?: string;
	/** Data directory holding `<realmId>/books.db` (the CLI's data dir). */
	dataDir: string;
	/** The QuickBooks company whose mirror this daemon serves. */
	realmId: string;
};

export function localBooksMount({
	baseURL,
	dataDir,
	realmId,
}: LocalBooksMountOptions) {
	return localBooksWorkspace.mount({
		baseURL,
		runtime: nodeMountRuntime(),
		compose: () => ({
			actions: createBooksAgentActions({ dbPath: dbPath(dataDir, realmId) }),
		}),
	});
}
