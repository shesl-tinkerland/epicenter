/**
 * The advertised tool surface is a capability lattice: the agent is only offered
 * what the daemon can actually do. This pins which tools each mode exposes,
 * resolved through the same dispatch catalog the client agent loop uses.
 */

import { describe, expect, test } from 'bun:test';
import {
	createDispatchToolCatalog,
	type DispatchSurface,
} from '@epicenter/workspace/agent';
import { Ok } from 'wellcrafted/result';
import type { QbClient } from '../qb-client.ts';
import { createBooksAgentActions } from './books-actions.ts';
import type { OpenQbClient } from './qb-access.ts';

const LOCAL_ONLY: DispatchSurface = {
	peers: { list: () => [] },
	dispatch: () => Promise.resolve(Ok(null)),
};

/** A QuickBooks opener that is never invoked here; only the manifest is read. */
const STUB_QB: OpenQbClient = () =>
	Promise.resolve(Ok(undefined as unknown as QbClient));

function advertised(opts: Parameters<typeof createBooksAgentActions>[0]) {
	const catalog = createDispatchToolCatalog(LOCAL_ONLY, {
		localActions: createBooksAgentActions(opts),
	});
	return catalog
		.definitions()
		.map((d) => d.name)
		.sort();
}

describe('the advertised tool capability lattice', () => {
	test('mirror-only daemon (no QuickBooks client) offers only the SQL read', () => {
		expect(advertised({ dbPath: '/tmp/unused.db' })).toEqual([
			'books_sql_query',
		]);
	});

	test('read-only daemon offers both reads but withholds the write', () => {
		expect(
			advertised({ dbPath: '/tmp/unused.db', openQb: STUB_QB, readOnly: true }),
		).toEqual(['books_report', 'books_sql_query']);
	});

	test('full daemon offers both reads and the write', () => {
		expect(
			advertised({
				dbPath: '/tmp/unused.db',
				openQb: STUB_QB,
				readOnly: false,
			}),
		).toEqual(['books_report', 'books_sql_query', 'recategorize_expense']);
	});

	test('recategorize_expense is a mutation; the reads are queries', () => {
		const catalog = createDispatchToolCatalog(LOCAL_ONLY, {
			localActions: createBooksAgentActions({
				dbPath: '/tmp/unused.db',
				openQb: STUB_QB,
			}),
		});
		const byName = new Map(
			catalog.definitions().map((d) => [d.name, d.kind] as const),
		);
		expect(byName.get('books_sql_query')).toBe('query');
		expect(byName.get('books_report')).toBe('query');
		expect(byName.get('recategorize_expense')).toBe('mutation');
	});
});
