/**
 * SQLite Materializer Tests
 *
 * Tests the full attachSqlite lifecycle: DDL generation, full load,
 * incremental sync, FTS5 search, rebuild, and dispose. Uses real Yjs documents
 * with defineTable schemas so the materializer exercises the actual workspace
 * observation path, and `:memory:` sqlite for hermetic isolation.
 *
 * Key behaviors:
 * - Materializer waits for `whenReady` before touching SQLite
 * - Full load inserts all valid rows on initialization
 * - Observer-based sync upserts changed rows and deletes removed rows
 * - FTS5 search returns ranked results with snippets
 * - rebuild() drops and recreates all materialized data
 * - dispose() stops observers and closes the database
 */

import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { type } from 'arktype';
import * as Y from 'yjs';
import {
	attachTables,
	createDisposableCache,
	defineTable,
} from '../index.js';
import { attachSqlite } from './attach-sqlite.js';
import { isAction, isMutation, isQuery } from '@epicenter/sync';

const postsTable = defineTable(
	type({ id: 'string', _v: '1', title: 'string', 'published?': 'boolean' }),
);

const notesTable = defineTable(type({ id: 'string', _v: '1', body: 'string' }));

const tableDefinitions = { posts: postsTable, notes: notesTable };

const hasFts5 = canUseFts5();

type AttachedTables = ReturnType<
	typeof attachTables<typeof tableDefinitions>
>;
type Materializer = ReturnType<typeof attachSqlite>;
type TableRegistration = {
	table: Parameters<Materializer['table']>[0];
	config?: Parameters<Materializer['table']>[1];
};

type SetupOptions = {
	tables?: (t: AttachedTables) => TableRegistration[];
	waitFor?: Promise<unknown>;
};

function setup(options: SetupOptions = {}) {
	const cache = createDisposableCache((id: string) => {
		const ydoc = new Y.Doc({ guid: id });
		const tables = attachTables(ydoc, tableDefinitions);

		const materializer = attachSqlite(ydoc, {
			filePath: ':memory:',
			waitFor: options.waitFor,
		});

		const registrations =
			options.tables?.(tables) ??
			([{ table: tables.posts }, { table: tables.notes }] as TableRegistration[]);
		for (const { table, config } of registrations) {
			materializer.table(table, config);
		}

		return {
			ydoc,
			tables,
			sqlite: materializer,
			[Symbol.dispose]() {
				ydoc.destroy();
			},
		};
	}, { gcTime: 0 });

	const workspace = cache.open('test');
	return { workspace, cache };
}

function createDeferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((promiseResolve) => {
		resolve = promiseResolve;
	});

	return { promise, resolve };
}

function canUseFts5() {
	const raw = new Database(':memory:');

	try {
		raw.run('CREATE VIRTUAL TABLE test_fts USING fts5(title)');
		return true;
	} catch {
		return false;
	} finally {
		raw.close();
	}
}

async function waitForSyncCycle() {
	await new Promise((resolve) => setTimeout(resolve, 200));
}

function getRows(db: Database, tableName: string) {
	return db
		.prepare(`SELECT * FROM "${tableName}" ORDER BY "id"`)
		.all() as Record<string, unknown>[];
}

function hasTable(db: Database, tableName: string) {
	const row = db
		.prepare('SELECT name FROM sqlite_master WHERE type = ? AND name = ?')
		.get('table', tableName);
	return row != null;
}

async function cleanup(setupResult: ReturnType<typeof setup>) {
	setupResult.workspace[Symbol.dispose]();
}

// ============================================================================
// READINESS Tests
// ============================================================================

describe('attachSqlite', () => {
	describe('readiness', () => {
		test('waits for whenReady before touching SQLite', async () => {
			const gate = createDeferred();
			const testSetup = setup({ waitFor: gate.promise });

			try {
				await new Promise((resolve) => setTimeout(resolve, 25));
				expect(hasTable(testSetup.workspace.sqlite.db, 'posts')).toBe(false);

				gate.resolve();
				await testSetup.workspace.sqlite.whenLoaded;

				expect(hasTable(testSetup.workspace.sqlite.db, 'posts')).toBe(true);
			} finally {
				gate.resolve();
				await cleanup(testSetup);
			}
		});
	});

	// ============================================================================
	// FULL LOAD Tests
	// ============================================================================

	describe('full load', () => {
		test('mirrors existing rows on initialization', async () => {
			const testSetup = setup();

			try {
				testSetup.workspace.tables.posts.set({
					id: 'post-1',
					title: 'Hello mirror',
					published: true,
					_v: 1,
				});
				testSetup.workspace.tables.posts.set({
					id: 'post-2',
					title: 'Second row',
					_v: 1,
				});

				await testSetup.workspace.sqlite.whenLoaded;

				expect(getRows(testSetup.workspace.sqlite.db, 'posts')).toEqual([
					{ id: 'post-1', _v: 1, published: 1, title: 'Hello mirror' },
					{ id: 'post-2', _v: 1, published: null, title: 'Second row' },
				]);
			} finally {
				await cleanup(testSetup);
			}
		});

		test('mirrors only specified tables when tables option is provided', async () => {
			const testSetup = setup({ tables: (t) => [{ table: t.posts }] });

			try {
				testSetup.workspace.tables.posts.set({
					id: 'post-1',
					title: 'Mirrored post',
					_v: 1,
				});
				testSetup.workspace.tables.notes.set({
					id: 'note-1',
					body: 'Ignored note',
					_v: 1,
				});

				await testSetup.workspace.sqlite.whenLoaded;

				expect(hasTable(testSetup.workspace.sqlite.db, 'posts')).toBe(true);
				expect(hasTable(testSetup.workspace.sqlite.db, 'notes')).toBe(false);
				expect(getRows(testSetup.workspace.sqlite.db, 'posts')).toEqual([
					{ id: 'post-1', _v: 1, published: null, title: 'Mirrored post' },
				]);
			} finally {
				await cleanup(testSetup);
			}
		});
	});

	// ============================================================================
	// INCREMENTAL SYNC Tests
	// ============================================================================

	describe('incremental sync', () => {
		test('upserts rows added after initialization', async () => {
			const testSetup = setup();

			try {
				await testSetup.workspace.sqlite.whenLoaded;

				testSetup.workspace.tables.posts.set({
					id: 'post-1',
					title: 'Added later',
					published: true,
					_v: 1,
				});

				await waitForSyncCycle();

				expect(getRows(testSetup.workspace.sqlite.db, 'posts')).toEqual([
					{ id: 'post-1', _v: 1, published: 1, title: 'Added later' },
				]);
			} finally {
				await cleanup(testSetup);
			}
		});

		test('deletes rows removed from workspace', async () => {
			const testSetup = setup();

			try {
				testSetup.workspace.tables.posts.set({
					id: 'post-1',
					title: 'Delete me',
					_v: 1,
				});

				await testSetup.workspace.sqlite.whenLoaded;
				testSetup.workspace.tables.posts.delete('post-1');

				await waitForSyncCycle();

				expect(getRows(testSetup.workspace.sqlite.db, 'posts')).toEqual([]);
			} finally {
				await cleanup(testSetup);
			}
		});

		test('updates rows modified in workspace', async () => {
			const testSetup = setup();

			try {
				testSetup.workspace.tables.posts.set({
					id: 'post-1',
					title: 'Before update',
					published: true,
					_v: 1,
				});

				await testSetup.workspace.sqlite.whenLoaded;
				testSetup.workspace.tables.posts.update({
					id: 'post-1',
					title: 'After update',
					published: false,
				});

				await waitForSyncCycle();

				expect(getRows(testSetup.workspace.sqlite.db, 'posts')).toEqual([
					{ id: 'post-1', _v: 1, published: 0, title: 'After update' },
				]);
			} finally {
				await cleanup(testSetup);
			}
		});
	});

	// ============================================================================
	// REBUILD Tests
	// ============================================================================

	describe('rebuild', () => {
		test('rebuild repopulates SQLite from Yjs', async () => {
			const testSetup = setup();

			try {
				testSetup.workspace.tables.posts.set({
					id: 'post-1',
					title: 'Persisted in Yjs',
					_v: 1,
				});

				await testSetup.workspace.sqlite.whenLoaded;
				testSetup.workspace.sqlite.db.run('DELETE FROM "posts"');

				expect(getRows(testSetup.workspace.sqlite.db, 'posts')).toEqual([]);

				await testSetup.workspace.sqlite.rebuild({});

				expect(getRows(testSetup.workspace.sqlite.db, 'posts')).toEqual([
					{ id: 'post-1', _v: 1, published: null, title: 'Persisted in Yjs' },
				]);
			} finally {
				await cleanup(testSetup);
			}
		});

		test('rebuild single table without touching others', async () => {
			const testSetup = setup();

			try {
				testSetup.workspace.tables.posts.set({
					id: 'post-1',
					title: 'Post row',
					_v: 1,
				});
				testSetup.workspace.tables.notes.set({
					id: 'note-1',
					body: 'Note row',
					_v: 1,
				});

				await testSetup.workspace.sqlite.whenLoaded;
				testSetup.workspace.sqlite.db.run('DELETE FROM "posts"');

				expect(getRows(testSetup.workspace.sqlite.db, 'posts')).toEqual([]);
				expect(
					getRows(testSetup.workspace.sqlite.db, 'notes'),
				).toHaveLength(1);

				await testSetup.workspace.sqlite.rebuild({ table: 'posts' });

				expect(getRows(testSetup.workspace.sqlite.db, 'posts')).toEqual([
					{ id: 'post-1', _v: 1, published: null, title: 'Post row' },
				]);
				expect(
					getRows(testSetup.workspace.sqlite.db, 'notes'),
				).toHaveLength(1);
			} finally {
				await cleanup(testSetup);
			}
		});

		test('rebuild throws for unknown table name', async () => {
			const testSetup = setup();

			try {
				await testSetup.workspace.sqlite.whenLoaded;

				expect(() =>
					testSetup.workspace.sqlite.rebuild({
						table: 'nonexistent',
					}),
				).toThrow('not in the materialized table set');
			} finally {
				await cleanup(testSetup);
			}
		});
	});

	describe('count', () => {
		test('count returns row count for a materialized table', async () => {
			const testSetup = setup();

			try {
				testSetup.workspace.tables.posts.set({
					id: 'post-1',
					title: 'First',
					_v: 1,
				});
				testSetup.workspace.tables.posts.set({
					id: 'post-2',
					title: 'Second',
					_v: 1,
				});

				await testSetup.workspace.sqlite.whenLoaded;

				expect(
					await testSetup.workspace.sqlite.count({ table: 'posts' }),
				).toBe(2);
				expect(
					await testSetup.workspace.sqlite.count({ table: 'notes' }),
				).toBe(0);
			} finally {
				await cleanup(testSetup);
			}
		});

		test('count throws on a table that was never registered', async () => {
			const testSetup = setup();

			try {
				await testSetup.workspace.sqlite.whenLoaded;

				expect(() =>
					testSetup.workspace.sqlite.count({ table: 'nonexistent' }),
				).toThrow(/not in the materialized table set/);
			} finally {
				await cleanup(testSetup);
			}
		});
	});

	// ============================================================================
	// DISPOSE Tests
	// ============================================================================

	describe('dispose', () => {
		test('dispose closes the database without throwing', async () => {
			const testSetup = setup();
			await testSetup.workspace.sqlite.whenLoaded;

			testSetup.workspace.tables.posts.set({
				id: 'post-1',
				title: 'Queued row',
				_v: 1,
			});

			// Disposing the ydoc closes the materializer's database. Subsequent
			// queries error at the driver layer; the test asserts the dispose
			// path itself is clean.
			expect(() => testSetup.workspace[Symbol.dispose]()).not.toThrow();
			await waitForSyncCycle();
		});
	});

	// ============================================================================
	// SEARCH Tests
	// ============================================================================

	describe('search', () => {
		test('search returns empty array when fts is not configured', async () => {
			const testSetup = setup();

			try {
				await testSetup.workspace.sqlite.whenLoaded;

				expect(
					await testSetup.workspace.sqlite.search({
						table: 'posts',
						query: 'hello',
					}),
				).toEqual([]);
			} finally {
				await cleanup(testSetup);
			}
		});

		if (hasFts5) {
			test('search returns ranked results with snippets when fts is configured', async () => {
				const testSetup = setup({
					tables: (t) => [
						{ table: t.posts, config: { fts: ['title'] } },
						{ table: t.notes },
					],
				});

				try {
					testSetup.workspace.tables.posts.set({
						id: 'post-1',
						title: 'Epicenter local-first mirror',
						_v: 1,
					});
					testSetup.workspace.tables.posts.set({
						id: 'post-2',
						title: 'Another search result',
						_v: 1,
					});

					await testSetup.workspace.sqlite.whenLoaded;

					const results = (await testSetup.workspace.sqlite.search({
						table: 'posts',
						query: 'mirror',
						limit: 10,
					})) as Array<{ id: string; snippet: string; rank: number }>;

					expect(results).toHaveLength(1);
					expect(results[0]?.id).toBe('post-1');
					expect(results[0]?.snippet).toContain('<mark>');
					expect(typeof results[0]?.rank).toBe('number');
				} finally {
					await cleanup(testSetup);
				}
			});
		}
	});

	// ============================================================================
	// ACTION BRAND Tests
	// ============================================================================

	describe('action brand', () => {
		test('search, count, rebuild are detectable via isAction()', async () => {
			const testSetup = setup();

			try {
				const { sqlite } = testSetup.workspace;
				expect(isAction(sqlite.search)).toBe(true);
				expect(isAction(sqlite.count)).toBe(true);
				expect(isAction(sqlite.rebuild)).toBe(true);

				expect(isQuery(sqlite.search)).toBe(true);
				expect(isQuery(sqlite.count)).toBe(true);
				expect(isMutation(sqlite.rebuild)).toBe(true);
			} finally {
				await cleanup(testSetup);
			}
		});
	});
});
