/**
 * Y.Doc durability via an append-log SQLite file.
 *
 * Owns one SQLite file (`updates` table, BLOB column, autoincrement id).
 * Every Y.Doc `updateV2` becomes a row; on load the rows are replayed in id
 * order; periodically the log is compacted into a single state-as-update
 * row. Pairs with `attachSync` for cross-machine convergence; pairs with
 * `attachYjsLogReader` for read-only consumers (script-side
 * mirrors, the daemon-as-materializer-worker design).
 *
 * Distinct from `attachSqlite`, which writes a different file
 * with derived per-table rows for SQL queries. This module is the
 * Y.Doc-update-log persistence layer; that one is the projection layer.
 *
 * The on-disk format is shared with `attachYjsLogReader`. If
 * you change the schema or the replay invariants here, change them there
 * too. WAL is enabled so a readonly consumer can open the same file
 * concurrently and read snapshot pages without `SQLITE_BUSY`.
 */

import { Database } from 'bun:sqlite';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createLogger } from 'wellcrafted/logger';
import * as Y from 'yjs';
import { applyWriterPragmas } from './sqlite-writer-pragmas.js';

const logger = createLogger('attachYjsLog');

/** Max compacted update size (2 MB). Matches the Cloudflare DO limit. */
const MAX_COMPACTED_BYTES = 2 * 1024 * 1024;

/**
 * Compact when accumulated incremental updates exceed this size.
 *
 * Targets the real problem: large row replacements (e.g. 30 KB autosaves)
 * accumulating over long desktop sessions. At 2 MB the log is guaranteed
 * to be 10-50x larger than the compact doc for typical workloads. Low
 * enough to prevent multi-MB logs; high enough to ignore thousands of
 * tiny keystroke updates that total only a few hundred KB.
 */
const COMPACTION_BYTE_THRESHOLD = 2 * 1024 * 1024;

/**
 * Debounce compaction by 5 s after the byte threshold is crossed.
 *
 * Prevents compacting during a burst of rapid writes (e.g. bulk import).
 * The compaction itself is fast (~16 ms for 10 K rows) but we don't want
 * to interrupt a hot write path.
 */
const COMPACTION_DEBOUNCE_MS = 5_000;

/**
 * Compact the SQLite update log into a single row.
 *
 * Encodes the current doc state via `Y.encodeStateAsUpdateV2`, which
 * produces smaller output than merging individual updates. No-ops if
 * the log already has <= 1 row or the compacted blob exceeds 2 MB.
 *
 * @returns `true` if compaction ran, `false` if it no-oped.
 */
function compactUpdateLog(db: Database, ydoc: Y.Doc): boolean {
	const row = db.query('SELECT COUNT(*) as count FROM updates').get() as {
		count: number;
	};
	if (row.count <= 1) return false;

	const compacted = Y.encodeStateAsUpdateV2(ydoc);
	if (compacted.byteLength > MAX_COMPACTED_BYTES) return false;

	db.transaction(() => {
		db.run('DELETE FROM updates');
		db.run('INSERT INTO updates (data) VALUES (?)', [compacted]);
	})();
	return true;
}

export type YjsLogAttachment = {
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

export function attachYjsLog(
	ydoc: Y.Doc,
	{ filePath }: { filePath: string },
): YjsLogAttachment {
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
		// Concurrency PRAGMAs for the daemon-as-sole-writer setup: WAL lets
		// `attachYjsLogReader` snapshot-read this file
		// concurrently; synchronous = NORMAL is the canonical durability
		// tradeoff under WAL; busy_timeout keeps writes patient when a reader
		// holds a snapshot through a checkpoint. Each pragma is best-effort:
		// `:memory:` rejects WAL and we just continue with the driver default
		// rather than failing the attachment.
		applyWriterPragmas(db, logger);

		db.run(
			'CREATE TABLE IF NOT EXISTS updates (id INTEGER PRIMARY KEY AUTOINCREMENT, data BLOB NOT NULL)',
		);

		// bun:sqlite returns BLOB columns as Uint8Array; Y.applyUpdateV2
		// accepts Uint8Array directly.
		const rows = db.query('SELECT data FROM updates ORDER BY id').all() as {
			data: Uint8Array;
		}[];
		for (const row of rows) {
			Y.applyUpdateV2(ydoc, row.data);
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
				// Final compaction can throw on a corrupt write or a closed
				// db. Swallowing silently inside teardown leaves no trace
				// for debugging; log instead so the failure surfaces.
				try {
					compactUpdateLog(db, ydoc);
				} catch (cause) {
					logger.warn(
						new Error('Final compactUpdateLog failed during destroy', {
							cause,
						}),
					);
				}
				// `db.close()` can throw if the handle was already closed or
				// if SQLite refuses (e.g. unfinalized statements). Same
				// rationale: log, don't let it escape the destroy listener.
				try {
					db.close();
				} catch (cause) {
					logger.warn(
						new Error('db.close() failed during destroy', { cause }),
					);
				}
				db = null;
			}
		} finally {
			resolveDisposed();
		}
	});

	return {
		whenLoaded,
		clearLocal: async () => {
			db?.run('DELETE FROM updates');
		},
		whenDisposed,
	};
}

