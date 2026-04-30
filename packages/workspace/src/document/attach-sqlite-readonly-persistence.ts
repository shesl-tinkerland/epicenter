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
 * Missing files are a no-op: `whenLoaded` resolves immediately with no
 * replay (the Y.Doc stays empty). `fileExisted` distinguishes the warm
 * path (file was there, rows replayed) from the cold path (file absent,
 * caller falls through to cloud sync). The writer is expected to have set
 * WAL on the file so concurrent readers get snapshot pages without
 * `SQLITE_BUSY`.
 */

import { Database } from 'bun:sqlite';
import * as Y from 'yjs';

export type SqliteReadonlyPersistenceAttachment = {
	/**
	 * Resolves once any existing rows have replayed. If the file did not
	 * exist at open time, resolves immediately with no replay (the Y.Doc
	 * stays empty). Pair with `fileExisted` to detect which path ran.
	 */
	whenLoaded: Promise<unknown>;
	/**
	 * Resolves to `true` if the file existed at open time and rows were
	 * replayed; `false` if the daemon has not written here yet. Snapshot
	 * value, taken once at construction; the file is not re-checked later.
	 */
	fileExisted: Promise<boolean>;
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

	const fileExisted: Promise<boolean> = Bun.file(filePath).exists();

	const whenLoaded = (async () => {
		if (!(await fileExisted)) return;
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

	return { whenLoaded, fileExisted, whenDisposed };
}
