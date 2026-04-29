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

const logger = createLogger('attachSqlite');

/** Errors surfaced by `attachSqlite`, both at the boundary and via the logger. */
export const AttachSqliteError = defineErrors({
	/**
	 * `PRAGMA journal_mode = WAL` failed. Logged, not thrown: drivers like
	 * `:memory:` legitimately reject WAL, and the writer can proceed with
	 * the default journal mode (concurrent readers just lose snapshot
	 * isolation). Mirrors the materializer's `WalPragmaFailed`.
	 */
	WalPragmaFailed: ({ cause }: { cause: unknown }) => ({
		message: '[attachSqlite] PRAGMA journal_mode = WAL failed',
		cause,
	}),
});
export type AttachSqliteError = InferErrors<typeof AttachSqliteError>;

export type SqliteAttachment = {
	/**
	 * Resolves when local SQLite state has replayed into the Y.Doc — "your
	 * draft is in memory, edits are safe." Not CRDT convergence. Pair with
	 * `sync.whenConnected` when you also need remote state.
	 */
	whenLoaded: Promise<unknown>;
	clearLocal: () => Promise<void>;
	/**
	 * Resolves after the Y.Doc is destroyed AND final compaction + DB close
	 * complete. Opt-in — tests and CLIs flushing before exit await this.
	 * Named symmetrically with `whenLoaded` — both are promises.
	 */
	whenDisposed: Promise<unknown>;
};

export function attachSqlite(
	ydoc: Y.Doc,
	{ filePath }: { filePath: string },
): SqliteAttachment {
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
		// Enable WAL so a future reader can open the same file
		// `{ readonly: true }` and run snapshot reads concurrently with this
		// writer. Some drivers (`:memory:`, certain test setups) reject WAL:
		// log and continue with the driver default rather than failing the
		// attachment. Mirrors the materializer's WAL pragma.
		try {
			db.run('PRAGMA journal_mode = WAL');
		} catch (cause) {
			logger.warn(AttachSqliteError.WalPragmaFailed({ cause }));
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
