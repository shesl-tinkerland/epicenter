/**
 * Read-only hydrator for an `attachSqlitePersistence` file.
 *
 * Opens a file the writer (`attachSqlitePersistence`) owns, replays every
 * `updates` row into the Y.Doc once, and stops there: no `updateV2`
 * listener, no compaction timer, no writes. The reader's Y.Doc can mutate
 * freely afterwards; mutations stay in memory and never flow back to disk.
 *
 * Use case: script-side mirror of a daemon's persistence file (the
 * daemon-as-materializer-worker design at
 * `specs/20260429T235500-daemon-as-materializer-worker.md`).
 *
 * The file must already exist; missing files reject `whenLoaded` with
 * `MissingFile` rather than silently creating an empty database. The
 * existence check uses `Bun.file(filePath).exists()`, matching the rest
 * of the codebase's Bun-native I/O. The writer is expected to have set
 * WAL on the file so concurrent readers get snapshot pages without
 * `SQLITE_BUSY`.
 */

import { Database } from 'bun:sqlite';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import * as Y from 'yjs';

/** Errors surfaced by `attachSqliteReadonlyPersistence` at the boundary. */
export const AttachSqliteReadonlyPersistenceError = defineErrors({
	/**
	 * The persistence file does not exist on disk. Distinguishes "no daemon
	 * has ever written to this path" from a real driver failure; callers
	 * can choose to skip the readonly attachment and fall back to a fresh
	 * Y.Doc (synced via `attachSync`) instead.
	 */
	MissingFile: ({ filePath }: { filePath: string }) => ({
		message: `[attachSqliteReadonlyPersistence] file does not exist: ${filePath}. Surfaced as a whenLoaded rejection; the writer (attachSqlitePersistence) has not created the file yet, or the path is wrong.`,
		filePath,
	}),
});
export type AttachSqliteReadonlyPersistenceError = InferErrors<
	typeof AttachSqliteReadonlyPersistenceError
>;

export type SqliteReadonlyPersistenceAttachment = {
	/**
	 * Resolves when the SQLite file's existing rows have replayed into the
	 * Y.Doc. After this resolves the reader's Y.Doc reflects the writer's
	 * state at open time; subsequent writer changes are NOT observed (this
	 * is a one-shot hydrate, not a live mirror).
	 */
	whenLoaded: Promise<unknown>;
	/**
	 * Resolves after `ydoc.destroy()` AND `db.close()`. No final compaction
	 * (the reader never wrote). Opt-in: tests and CLIs flushing before
	 * exit await this.
	 */
	whenDisposed: Promise<unknown>;
};

export function attachSqliteReadonlyPersistence(
	ydoc: Y.Doc,
	{ filePath }: { filePath: string },
): SqliteReadonlyPersistenceAttachment {
	let db: Database | null = null;

	const whenLoaded = (async () => {
		if (!(await Bun.file(filePath).exists())) {
			throw AttachSqliteReadonlyPersistenceError.MissingFile({ filePath })
				.error;
		}
		db = new Database(filePath, { readonly: true });
		// File is owned by the writer. No CREATE TABLE, no WAL pragma (the
		// writer set it), no updateV2 listener, no compaction: pure snapshot
		// consumer.
		const rows = db.query('SELECT data FROM updates ORDER BY id').all() as {
			data: Buffer;
		}[];
		for (const row of rows) {
			Y.applyUpdateV2(ydoc, new Uint8Array(row.data));
		}
	})();

	const { promise: whenDisposed, resolve: resolveDisposed } =
		Promise.withResolvers<void>();

	ydoc.once('destroy', () => {
		try {
			if (db) {
				db.close();
				db = null;
			}
		} finally {
			resolveDisposed();
		}
	});

	return { whenLoaded, whenDisposed };
}
