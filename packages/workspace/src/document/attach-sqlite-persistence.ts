/**
 * Y.Doc durability via an append-log SQLite file.
 *
 * Owns one SQLite file (`updates` table, BLOB column, autoincrement id).
 * Every Y.Doc `updateV2` becomes a row; on load the rows are replayed in id
 * order; periodically the log is compacted into a single state-as-update
 * row. Pairs with `attachSync` for cross-machine convergence; pairs with
 * `attachSqliteReadonlyPersistence` for read-only consumers (script-side
 * mirrors, the daemon-as-materializer-worker design).
 *
 * Distinct from `attachSqliteMaterializer`, which writes a different file
 * with derived per-table rows for SQL queries. This module is the
 * Y.Doc-update-log persistence layer; that one is the projection layer.
 *
 * The on-disk format is shared with `attachSqliteReadonlyPersistence`. If
 * you change the schema or the replay invariants here, change them there
 * too. WAL is enabled so a readonly consumer can open the same file
 * concurrently and read snapshot pages without `SQLITE_BUSY`.
 */

import { Database } from 'bun:sqlite';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { createLogger } from 'wellcrafted/logger';
import * as Y from 'yjs';
import {
	COMPACTION_BYTE_THRESHOLD,
	COMPACTION_DEBOUNCE_MS,
	compactUpdateLog,
} from './sqlite-update-log.js';

const logger = createLogger('attachSqlitePersistence');

/** Errors surfaced by `attachSqlitePersistence`, both at the boundary and via the logger. */
export const AttachSqlitePersistenceError = defineErrors({
	/**
	 * `PRAGMA journal_mode = WAL` failed. Logged, not thrown: drivers like
	 * `:memory:` legitimately reject WAL, and the writer can proceed with
	 * the default journal mode (concurrent readers just lose snapshot
	 * isolation). Mirrors the materializer's `WalPragmaFailed`.
	 */
	WalPragmaFailed: ({ cause }: { cause: unknown }) => ({
		message: '[attachSqlitePersistence] PRAGMA journal_mode = WAL failed',
		cause,
	}),
});
export type AttachSqlitePersistenceError = InferErrors<
	typeof AttachSqlitePersistenceError
>;

export type SqlitePersistenceAttachment = {
	/**
	 * Resolves when the SQLite file's existing rows have replayed into the
	 * Y.Doc: "your draft is in memory, edits are safe." Not CRDT
	 * convergence: pair with `sync.whenConnected` when you also need remote
	 * state.
	 */
	whenLoaded: Promise<unknown>;
	/** `DELETE FROM updates`. Drops the durable log without destroying the Y.Doc. */
	clearLocal: () => Promise<void>;
	/**
	 * Resolves after `ydoc.destroy()` AND a final compaction + DB close.
	 * Opt-in: tests and CLIs flushing before exit await this. Named
	 * symmetrically with `whenLoaded`: both are promises.
	 */
	whenDisposed: Promise<unknown>;
};

export function attachSqlitePersistence(
	ydoc: Y.Doc,
	{ filePath }: { filePath: string },
): SqlitePersistenceAttachment {
	let db: Database | null = null;
	let bytesSinceCompaction = 0;
	let compactionTimer: ReturnType<typeof setTimeout> | null = null;

	function resetCompactionTimer() {
		if (compactionTimer) {
			clearTimeout(compactionTimer);
			compactionTimer = null;
		}
	}

	const updateHandler = (update: Uint8Array) => {
		db?.run('INSERT INTO updates (data) VALUES (?)', [update]);

		bytesSinceCompaction += update.byteLength;
		if (bytesSinceCompaction > COMPACTION_BYTE_THRESHOLD) {
			resetCompactionTimer();
			compactionTimer = setTimeout(() => {
				if (db && compactUpdateLog(db, ydoc)) {
					bytesSinceCompaction = 0;
				}
			}, COMPACTION_DEBOUNCE_MS);
		}
	};

	const whenLoaded = (async () => {
		await mkdir(path.dirname(filePath), { recursive: true });

		db = new Database(filePath);
		// Enable WAL so `attachSqliteReadonlyPersistence` can open the same
		// file `{ readonly: true }` and run snapshot reads concurrently with
		// this writer. Some drivers (`:memory:`, certain test setups) reject
		// WAL: log and continue with the driver default rather than failing
		// the attachment. Mirrors the materializer's WAL pragma.
		try {
			db.run('PRAGMA journal_mode = WAL');
		} catch (cause) {
			logger.warn(AttachSqlitePersistenceError.WalPragmaFailed({ cause }));
		}
		db.run(
			'CREATE TABLE IF NOT EXISTS updates (id INTEGER PRIMARY KEY AUTOINCREMENT, data BLOB NOT NULL)',
		);

		const rows = db.query('SELECT data FROM updates ORDER BY id').all() as {
			data: Buffer;
		}[];
		for (const row of rows) {
			Y.applyUpdateV2(ydoc, new Uint8Array(row.data));
		}

		compactUpdateLog(db, ydoc);
		ydoc.on('updateV2', updateHandler);
	})();

	const { promise: whenDisposed, resolve: resolveDisposed } =
		Promise.withResolvers<void>();

	ydoc.once('destroy', () => {
		try {
			resetCompactionTimer();
			ydoc.off('updateV2', updateHandler);
			if (db) {
				compactUpdateLog(db, ydoc);
				db.close();
				db = null;
			}
		} finally {
			resolveDisposed();
		}
	});

	return {
		whenLoaded,
		clearLocal: () =>
			Promise.resolve().then(() => {
				db?.run('DELETE FROM updates');
			}),
		whenDisposed,
	};
}
