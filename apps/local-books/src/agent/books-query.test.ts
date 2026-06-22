/**
 * `books_sql_query` reached the way the client agent loop reaches it: as a
 * dispatched action resolved through `createDispatchToolCatalog`. A seeded mirror
 * stands in for a synced QuickBooks company. This proves the read-only path end
 * to end (a tool call -> the catalog -> the SQLite mirror -> bounded rows); the
 * loop that drives the catalog is proven in `@epicenter/workspace`'s loop tests.
 */

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	createDispatchToolCatalog,
	type DispatchSurface,
} from '@epicenter/workspace/agent';
import { Ok } from 'wellcrafted/result';
import { openBooksDb } from '../db.ts';
import { createBooksAgentActions } from './books-actions.ts';

/** No peers: a books action resolves in-process; dispatch is never reached. */
const LOCAL_ONLY: DispatchSurface = {
	peers: { list: () => [] },
	dispatch: () => Promise.resolve(Ok(null)),
};

/** Seed a mirror with two invoices (one soft-deleted); return its path. */
function fixtureMirror() {
	const dir = mkdtempSync(join(tmpdir(), 'local-books-'));
	const path = join(dir, 'realm-1', 'books.db');
	const db = openBooksDb(path);
	db.raw.exec(`
		CREATE TABLE invoices (
			id TEXT PRIMARY KEY, raw TEXT NOT NULL, updated_at TEXT,
			synced_at TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, total_amt REAL
		);
		INSERT INTO invoices (id, raw, synced_at, deleted, total_amt) VALUES
			('i1', '{"Id":"i1"}', '2026-01-01', 0, 100.0),
			('i2', '{"Id":"i2"}', '2026-01-01', 1, 50.0);
	`);
	db.close();
	return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function runQuery(dbPath: string, sql: string) {
	const catalog = createDispatchToolCatalog(LOCAL_ONLY, {
		localActions: createBooksAgentActions({ dbPath }),
	});
	return catalog.resolve(
		{ toolCallId: 't1', toolName: 'books_sql_query', input: { sql } },
		new AbortController().signal,
	);
}

describe('books_sql_query as a dispatched action', () => {
	test('the catalog advertises it as a query (auto-approved) tool', () => {
		const catalog = createDispatchToolCatalog(LOCAL_ONLY, {
			localActions: createBooksAgentActions({ dbPath: '/tmp/unused.db' }),
		});
		const def = catalog.definitions().find((d) => d.name === 'books_sql_query');
		expect(def?.kind).toBe('query');
	});

	test('runs a read-only SELECT and returns the live rows, bounded', async () => {
		const { path, cleanup } = fixtureMirror();
		const outcome = await runQuery(
			path,
			'SELECT id, total_amt FROM invoices WHERE deleted = 0',
		);
		expect(outcome.isError).toBe(false);
		expect(outcome.output).toMatchObject({ rowCount: 1, truncated: false });
		expect((outcome.output as { rows: unknown[] }).rows).toEqual([
			{ id: 'i1', total_amt: 100 },
		]);
		cleanup();
	});

	test('rejects a write: the read-only connection is the boundary', async () => {
		const { path, cleanup } = fixtureMirror();
		const outcome = await runQuery(
			path,
			"DELETE FROM invoices WHERE id = 'i1'",
		);
		expect(outcome.isError).toBe(true);
		cleanup();
	});

	test('errors clearly when no mirror exists yet', async () => {
		const outcome = await runQuery(
			join(tmpdir(), 'local-books-absent', 'realm', 'books.db'),
			'SELECT 1',
		);
		expect(outcome.isError).toBe(true);
		expect(String(outcome.output)).toContain('No QuickBooks mirror');
	});
});
