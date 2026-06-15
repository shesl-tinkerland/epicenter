/**
 * SQLite index extension for the Yjs filesystem.
 *
 * Mirrors the CRDT files table into an in-memory SQLite database
 * (libSQL WASM). Provides SQL queries, full-text search, and fast
 * lookups against file metadata and content.
 *
 * The SQLite database is **never** the source of truth: it is a derived,
 * rebuildable cache. On every page load the index is rebuilt from Yjs.
 * Ongoing mutations are picked up via a debounced table observer.
 *
 * The `path` column mirrors the runtime {@link FileSystemIndex}, which is
 * the single owner of path and parent-graph validity (cycle and orphan
 * repair, name disambiguation, trash exclusion). This extension never
 * computes paths itself; it converges to whatever the index says.
 *
 * Uses `@libsql/client-wasm` for browser WASM SQLite. To upgrade to
 * remote Turso, swap `url: ':memory:'` for `url: 'libsql://your-db.turso.io'`.
 *
 * @example
 * ```typescript
 * const workspace = createWorkspace({
 *   id: 'app',
 *   tables: { files: filesTable },
 *   kv: {},
 * });
 * const fs = attachYjsFileSystem(workspace.ydoc, workspace.tables.files, fileContent);
 * const sqliteIndex = createSqliteIndex({
 *   readContent: fileContent.read,
 *   index: fs.index,
 * })({ tables: workspace.tables });
 * await sqliteIndex.exports.whenReady;
 * const results = await sqliteIndex.exports.search('meeting notes');
 * ```
 *
 * @module
 */

import type { Table } from '@epicenter/workspace';
import { debounce } from '@epicenter/workspace';
import type { InStatement } from '@libsql/client-wasm';
import { createClient } from '@libsql/client-wasm';

import { asFileId, type FileId } from '../../ids.js';
import type { FileRow } from '../../table.js';
import type { FileSystemIndex } from '../../tree/path-index.js';

const FILES_DDL = `CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  parent_id TEXT,
  type TEXT NOT NULL,
  path TEXT,
  size INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  trashed_at INTEGER,
  content TEXT
)`;

const FILES_INDEXES = [
	'CREATE INDEX IF NOT EXISTS parent_idx ON files(parent_id)',
	'CREATE INDEX IF NOT EXISTS type_idx ON files(type)',
	'CREATE INDEX IF NOT EXISTS path_idx ON files(path)',
	'CREATE INDEX IF NOT EXISTS updated_idx ON files(updated_at)',
];

const FILES_FTS = `CREATE VIRTUAL TABLE IF NOT EXISTS files_fts
  USING fts5(file_id UNINDEXED, name, content)`;

// ════════════════════════════════════════════════════════════════════════════
// PUBLIC TYPES
// ════════════════════════════════════════════════════════════════════════════

export type SqliteIndexOptions = {
	/** Debounce interval (ms) between a table mutation and the next mirror sync. @default 100 */
	debounceMs?: number;
};

/**
 * A single full-text search result.
 *
 * Returned by {@link SqliteIndex.search}. The `snippet` field contains
 * an HTML fragment with `<mark>` tags around matched terms.
 */
export type SearchResult = {
	/** File ID matching the query. */
	id: string;
	/** File name. */
	name: string;
	/**
	 * Resolved absolute path from the runtime {@link FileSystemIndex},
	 * or null if the file is trashed or unreachable.
	 */
	path: string | null;
	/** FTS5 snippet with `<mark>` highlights around matched terms. */
	snippet: string;
};

// ════════════════════════════════════════════════════════════════════════════
// EXTENSION CONTEXT
// ════════════════════════════════════════════════════════════════════════════

/**
 * Minimal context shape this extension needs from the workspace.
 *
 * Structural subtyping means any workspace with a `files` table
 * (using `filesTable` from `@epicenter/filesystem`) satisfies this.
 */
type SqliteIndexContext = {
	tables: {
		files: Table<FileRow>;
	};
};

// ════════════════════════════════════════════════════════════════════════════
// FACTORY
// ════════════════════════════════════════════════════════════════════════════

/**
 * Create a SQLite index. Returns a curried factory: call with options, then
 * invoke the inner function with `{ tables }` to wire it into the workspace.
 *
 * `index` must be the runtime index attached to the same files table
 * (e.g. `fs.index` from `attachYjsFileSystem`). The index updates
 * synchronously on table mutations while this extension's sync is
 * debounced, so by the time a sync runs the index is already current.
 *
 * @example
 * ```typescript
 * const workspace = createWorkspace({
 *   id: 'app',
 *   tables: { files: filesTable },
 *   kv: {},
 * });
 * attachIndexedDb(workspace.ydoc);
 * const fs = attachYjsFileSystem(workspace.ydoc, workspace.tables.files, fileContent);
 * const sqliteIndex = createSqliteIndex({ readContent, index: fs.index })({
 *   tables: workspace.tables,
 * });
 * ```
 */
export function createSqliteIndex(
	{
		readContent,
		index,
	}: {
		readContent(fileId: FileId): Promise<string>;
		/** Runtime path owner; the mirror's `path` column converges to it. */
		index: FileSystemIndex;
	},
	{ debounceMs = 100 }: SqliteIndexOptions = {},
) {
	return (context: SqliteIndexContext) => {
		const filesTable = context.tables.files;

		const client = createClient({ url: ':memory:' });
		let pendingIds = new Set<string>();
		let unobserve: (() => void) | null = null;

		// ── Async initialization ──────────────────────────────────────
		const whenReady = (async () => {
			// WAL mode: no-op for in-memory but documents intent
			await client.execute('PRAGMA journal_mode = WAL');

			await client.execute(FILES_DDL);
			for (const idx of FILES_INDEXES) {
				await client.execute(idx);
			}

			// FTS5 virtual table: standalone (not external-content)
			await client.execute(FILES_FTS);

			// Initial rebuild from Yjs
			await rebuild();

			// Observe ongoing table mutations
			unobserve = filesTable.observe((changedIds) => scheduleSync(changedIds));
		})();

		// ── Debounced sync ────────────────────────────────────────────
		const syncAfterDebounce = debounce(() => {
			const ids = pendingIds;
			pendingIds = new Set();
			void syncRows(ids);
		}, debounceMs);

		function scheduleSync(changedIds: ReadonlySet<string>) {
			for (const id of changedIds) pendingIds.add(id);
			syncAfterDebounce();
		}

		// ── Full rebuild ──────────────────────────────────────────
		async function rebuild(): Promise<void> {
			const rows = filesTable.scan().rows;

			// Read content for files (skip folders)
			const contentMap = new Map<string, string | null>();
			for (const row of rows) {
				if (row.type === 'folder') {
					contentMap.set(row.id, null);
					continue;
				}
				try {
					const text = await readContent(row.id);
					contentMap.set(row.id, text || null);
				} catch {
					contentMap.set(row.id, null);
				}
			}

			// Build batch: nuke + reinsert in a single transaction
			const statements: InStatement[] = [
				'DELETE FROM files_fts',
				'DELETE FROM files',
			];

			for (const row of rows) {
				const path = index.getPathById(row.id) ?? null;
				const content = contentMap.get(row.id) ?? null;

				statements.push({
					sql: `INSERT INTO files
						(id, name, parent_id, type, path, size, created_at, updated_at, trashed_at, content)
						VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
					args: [
						row.id,
						row.name,
						row.parentId,
						row.type,
						path,
						row.size,
						row.createdAt,
						row.updatedAt,
						row.trashedAt,
						content,
					],
				});

				// Insert into FTS: use empty string for null content
				// so the file name is still searchable
				statements.push({
					sql: 'INSERT INTO files_fts (file_id, name, content) VALUES (?, ?, ?)',
					args: [row.id, row.name, content ?? ''],
				});
			}

			// libSQL batch executes all statements in a single transaction
			await client.batch(statements, 'write');
		}

		// ── Surgical sync ────────────────────────────────────────

		async function syncRows(changedIds: Set<string>): Promise<void> {
			const statements: InStatement[] = [];

			for (const id of changedIds) {
				const { data: row, error } = filesTable.get(id);
				if (error || row === null) {
					statements.push(
						{ sql: 'DELETE FROM files_fts WHERE file_id = ?', args: [id] },
						{ sql: 'DELETE FROM files WHERE id = ?', args: [id] },
					);
					continue;
				}

				let content: string | null = null;
				if (row.type !== 'folder') {
					try {
						content = (await readContent(row.id)) || null;
					} catch {
						content = null;
					}
				}

				statements.push(
					{ sql: 'DELETE FROM files_fts WHERE file_id = ?', args: [id] },
					{ sql: 'DELETE FROM files WHERE id = ?', args: [id] },
					{
						sql: `INSERT INTO files
							(id, name, parent_id, type, path, size, created_at, updated_at, trashed_at, content)
							VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
						args: [
							row.id,
							row.name,
							row.parentId,
							row.type,
							index.getPathById(row.id) ?? null,
							row.size,
							row.createdAt,
							row.updatedAt,
							row.trashedAt,
							content,
						],
					},
					{
						sql: 'INSERT INTO files_fts (file_id, name, content) VALUES (?, ?, ?)',
						args: [row.id, row.name, content ?? ''],
					},
				);
			}

			// Converge every other row's path to the index. Changed-row IDs
			// alone miss path ripples: renaming a folder rewrites every
			// descendant path, and creating/trashing/moving a row can
			// re-disambiguate a sibling's display name, all without those
			// rows themselves changing.
			const mirror = await client.execute('SELECT id, path FROM files');
			for (const mirrorRow of mirror.rows) {
				const rowId = mirrorRow.id as string;
				if (changedIds.has(rowId)) continue; // reinserted above with a fresh path
				const mirrorPath = (mirrorRow.path as string | null) ?? null;
				const indexPath = index.getPathById(asFileId(rowId)) ?? null;
				if (mirrorPath !== indexPath) {
					statements.push({
						sql: 'UPDATE files SET path = ? WHERE id = ?',
						args: [indexPath, rowId],
					});
				}
			}

			if (statements.length > 0) {
				await client.batch(statements, 'write');
			}
		}

		// ── Full-text search ──────────────────────────────────────────

		/**
		 * Search file names and content using FTS5 MATCH.
		 *
		 * Returns up to 50 results ranked by relevance, each with an
		 * HTML snippet (`<mark>` tags around matched terms).
		 */
		async function search(query: string): Promise<SearchResult[]> {
			const trimmed = query.trim();
			if (!trimmed) return [];

			try {
				// snippet() args: table, column-index, open, close, ellipsis, max-tokens
				const result = await client.execute({
					sql: `SELECT
						fts.file_id,
						f.name,
						f.path,
						snippet(files_fts, 2, '<mark>', '</mark>', '...', 64) AS snippet
					 FROM files_fts fts
					 JOIN files f ON f.id = fts.file_id
					 WHERE files_fts MATCH ?
					 ORDER BY rank
					 LIMIT 50`,
					args: [trimmed],
				});

				return result.rows.map((row) => ({
					id: row.file_id as string,
					name: row.name as string,
					path: (row.path as string | null) ?? null,
					snippet: row.snippet as string,
				}));
			} catch {
				// Invalid FTS5 query syntax: return empty rather than throw
				return [];
			}
		}

		// ── Extension exports ─────────────────────────────────────────
		return {
			/** Public exports surfaced on the document bundle's `sqliteIndex.exports`. */
			exports: {
				/** Raw libSQL client for arbitrary SQL queries. */
				get client() {
					return client;
				},
				/** Full-text search across file names and content. */
				search,
				/** Manually rebuild the entire index from Yjs. */
				rebuild,
				/** Resolves after the initial rebuild completes. */
				whenReady,
			},
			/** Readiness signal. Same promise as `exports.whenReady`. */
			init: whenReady,
			/** Dispose observers and close the SQLite database. */
			[Symbol.dispose]() {
				syncAfterDebounce.cancel();
				unobserve?.();
				client.close();
			},
		};
	};
}

/** The raw extension factory return: exports plus lifecycle metadata. */
export type SqliteIndex = ReturnType<ReturnType<typeof createSqliteIndex>>;

/** Public exports surfaced on the document bundle's `sqliteIndex.exports`. */
export type SqliteIndexExports = SqliteIndex['exports'];
