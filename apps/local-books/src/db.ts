import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { EntityDef } from './entities.ts';

/**
 * The local mirror: one SQLite file per company. Holds an entity table per QB
 * type plus `_sync_state` (the per-entity CDC cursor) and `_meta`. The cursor is
 * written in the same transaction as the rows it accounts for, so ingest and
 * cursor-advance are atomic and crash-safe (see the spec's atomicity argument).
 *
 * The realm owns its identity through the path (`<dataDir>/<realmId>/books.db`),
 * not a stored column, so the db need not know which company it holds.
 */

export const SCHEMA_VERSION = '1';

export type SyncStateRow = {
	entity: string;
	cdcCursor: string | null;
	lastFullPullAt: string | null;
	lastSyncedAt: string | null;
};

/**
 * One row destined for an entity table, keyed by QB `id`. The same shape feeds
 * an upsert (store this blob) and a soft-delete (the blob is a stub, used only
 * if the row is new); the destiny is the array it lands in, not the type. The
 * extracted columns are generated from `raw`, so no row carries them.
 */
export type MirrorRow = {
	id: string;
	raw: string;
	updatedAt: string | null;
};

export type EntityStatus = {
	entity: string;
	table: string;
	rows: number;
	deleted: number;
	cdcCursor: string | null;
	lastFullPullAt: string | null;
	lastSyncedAt: string | null;
};

const IDENT = /^[a-z_][a-z0-9_]*$/;
function assertIdent(name: string): string {
	if (!IDENT.test(name)) throw new Error(`Unsafe SQL identifier: ${name}`);
	return name;
}

// Generated-column paths are inlined into the CREATE TABLE string literal, so
// each QB field segment must be a bare identifier (no quotes, dots, or `$`).
const PATH_SEGMENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
function jsonExtractPath(segments: string[]): string {
	for (const seg of segments) {
		if (!PATH_SEGMENT.test(seg)) {
			throw new Error(`Unsafe JSON path segment: ${seg}`);
		}
	}
	return `$.${segments.join('.')}`;
}

export type BooksDb = ReturnType<typeof openBooksDb>;

export function openBooksDb(path: string) {
	mkdirSync(dirname(path), { recursive: true });
	const db = new Database(path, { create: true });
	db.exec('PRAGMA journal_mode = WAL;');
	db.exec('PRAGMA foreign_keys = ON;');

	db.exec(`
		CREATE TABLE IF NOT EXISTS _sync_state (
			entity            TEXT PRIMARY KEY,
			cdc_cursor        TEXT,
			last_full_pull_at TEXT,
			last_synced_at    TEXT
		);
		CREATE TABLE IF NOT EXISTS _meta (key TEXT PRIMARY KEY, value TEXT);
	`);

	const setMetaStmt = db.query(
		`INSERT INTO _meta (key, value) VALUES (?, ?)
		 ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
	);
	const getMetaStmt = db.query<{ value: string }, [string]>(
		`SELECT value FROM _meta WHERE key = ?`,
	);

	setMetaStmt.run('schema_version', SCHEMA_VERSION);

	// Prepared-statement caches, keyed by table.
	const upsertStmts = new Map<string, ReturnType<typeof db.query>>();
	const deleteStmts = new Map<string, ReturnType<typeof db.query>>();

	const writeSyncStateStmt = db.query(
		`INSERT INTO _sync_state (entity, cdc_cursor, last_full_pull_at, last_synced_at)
		 VALUES (?, ?, ?, ?)
		 ON CONFLICT(entity) DO UPDATE SET
		   cdc_cursor = excluded.cdc_cursor,
		   last_full_pull_at = excluded.last_full_pull_at,
		   last_synced_at = excluded.last_synced_at`,
	);

	function ensureEntityTable(def: EntityDef): void {
		const table = assertIdent(def.table);
		// Each extracted column is a VIRTUAL generated projection of `raw`, so the
		// blob stays the single source of truth: no write-path extraction, and a
		// missing field is `json_extract`'s null for free.
		const extra = def.columns
			.map(
				(c) =>
					`${assertIdent(c.name)} ${c.type} GENERATED ALWAYS AS (json_extract(raw, '${jsonExtractPath(c.path)}')) VIRTUAL`,
			)
			.join(',\n\t\t\t\t');
		db.exec(`
			CREATE TABLE IF NOT EXISTS ${table} (
				id          TEXT PRIMARY KEY,
				raw         TEXT NOT NULL,
				updated_at  TEXT,
				synced_at   TEXT NOT NULL,
				deleted     INTEGER NOT NULL DEFAULT 0${extra ? ',\n\t\t\t\t' + extra : ''}
			);
			CREATE INDEX IF NOT EXISTS idx_${table}_updated_at ON ${table}(updated_at);
		`);
	}

	function upsertStmtFor(def: EntityDef) {
		const cached = upsertStmts.get(def.table);
		if (cached) return cached;
		// The extracted columns are generated from `raw`, so the upsert writes only
		// the blob and its bookkeeping; SQLite recomputes the projections.
		const stmt = db.query(
			`INSERT INTO ${assertIdent(def.table)} (id, raw, updated_at, synced_at, deleted)
			 VALUES (?, ?, ?, ?, 0)
			 ON CONFLICT(id) DO UPDATE SET
			   raw = excluded.raw,
			   updated_at = excluded.updated_at,
			   synced_at = excluded.synced_at,
			   deleted = 0`,
		);
		upsertStmts.set(def.table, stmt);
		return stmt;
	}

	function deleteStmtFor(def: EntityDef) {
		const cached = deleteStmts.get(def.table);
		if (cached) return cached;
		// On conflict, only flip the flag + timestamps: keep the existing blob,
		// since a CDC delete payload is just a stub. The generated columns keep
		// projecting that preserved blob, so the last-known scalars survive.
		const stmt = db.query(
			`INSERT INTO ${assertIdent(def.table)} (id, raw, updated_at, synced_at, deleted)
			 VALUES (?, ?, ?, ?, 1)
			 ON CONFLICT(id) DO UPDATE SET
			   deleted = 1,
			   synced_at = excluded.synced_at,
			   updated_at = excluded.updated_at`,
		);
		deleteStmts.set(def.table, stmt);
		return stmt;
	}

	function readSyncState(entity: string): SyncStateRow | null {
		const row = db
			.query<
				{
					entity: string;
					cdc_cursor: string | null;
					last_full_pull_at: string | null;
					last_synced_at: string | null;
				},
				[string]
			>(`SELECT * FROM _sync_state WHERE entity = ?`)
			.get(entity);
		if (!row) return null;
		return {
			entity: row.entity,
			cdcCursor: row.cdc_cursor,
			lastFullPullAt: row.last_full_pull_at,
			lastSyncedAt: row.last_synced_at,
		};
	}

	return {
		/** Escape hatch for ad-hoc queries (tests, diagnostics). */
		raw: db,

		/**
		 * Apply one entity's sync result atomically: upserts, soft-deletes, and the
		 * advanced `_sync_state` cursor all commit in a single transaction. A crash
		 * mid-write rolls back to the prior cursor, so the next run re-pulls the same
		 * window (idempotent) rather than skipping it.
		 */
		applyEntitySync(
			def: EntityDef,
			{
				upserts,
				deletes,
				syncState,
				syncedAt,
			}: {
				upserts: MirrorRow[];
				deletes: MirrorRow[];
				syncState: SyncStateRow;
				syncedAt: string;
			},
		): void {
			ensureEntityTable(def);
			const upsert = upsertStmtFor(def);
			const markDeleted = deleteStmtFor(def);
			const tx = db.transaction(() => {
				for (const row of upserts) {
					upsert.run(row.id, row.raw, row.updatedAt, syncedAt);
				}
				for (const row of deletes) {
					markDeleted.run(row.id, row.raw, row.updatedAt, syncedAt);
				}
				writeSyncStateStmt.run(
					syncState.entity,
					syncState.cdcCursor,
					syncState.lastFullPullAt,
					syncState.lastSyncedAt,
				);
			});
			tx();
		},

		/**
		 * Fold just-mutated objects back into the mirror without advancing the CDC
		 * cursor. The write-back path (recategorize) uses this so a read sees the
		 * new state immediately after a QuickBooks update; the next CDC sync
		 * reconfirms it through the normal cursor-advancing path.
		 */
		upsertObjects(def: EntityDef, rows: MirrorRow[], syncedAt: string): void {
			ensureEntityTable(def);
			const upsert = upsertStmtFor(def);
			const tx = db.transaction(() => {
				for (const row of rows) {
					upsert.run(row.id, row.raw, row.updatedAt, syncedAt);
				}
			});
			tx();
		},

		readSyncState,

		getMeta(key: string): string | null {
			return getMetaStmt.get(key)?.value ?? null;
		},

		entityStatus(def: EntityDef): EntityStatus {
			const table = assertIdent(def.table);
			const exists = db
				.query<{ n: number }, [string]>(
					`SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name = ?`,
				)
				.get(def.table);
			const state = readSyncState(def.name);
			if (!exists || exists.n === 0) {
				return {
					entity: def.name,
					table: def.table,
					rows: 0,
					deleted: 0,
					cdcCursor: state?.cdcCursor ?? null,
					lastFullPullAt: state?.lastFullPullAt ?? null,
					lastSyncedAt: state?.lastSyncedAt ?? null,
				};
			}
			const rows = db
				.query<{ n: number }, []>(`SELECT count(*) AS n FROM ${table}`)
				.get();
			const deleted = db
				.query<{ n: number }, []>(
					`SELECT count(*) AS n FROM ${table} WHERE deleted = 1`,
				)
				.get();
			return {
				entity: def.name,
				table: def.table,
				rows: rows?.n ?? 0,
				deleted: deleted?.n ?? 0,
				cdcCursor: state?.cdcCursor ?? null,
				lastFullPullAt: state?.lastFullPullAt ?? null,
				lastSyncedAt: state?.lastSyncedAt ?? null,
			};
		},

		close(): void {
			db.close();
		},
	};
}
