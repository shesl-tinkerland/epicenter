/**
 * Read-only hydrator for an `attachYjsLog` file.
 *
 * Opens a file the writer (`attachYjsLog`) owns, replays every
 * `updates` row into the Y.Doc once, and stops there: no `updateV2`
 * listener, no compaction timer, no writes. The reader's Y.Doc can mutate
 * freely afterwards; mutations stay in memory and never flow back to disk.
 *
 * Use case: script-side mirror of a daemon's persistence file (the
 * daemon-as-materializer-worker design at
 * `specs/20260429T235500-daemon-as-materializer-worker.md`).
 *
 * Missing files are a no-op: `fileExisted` is `false` with no replay
 * (the Y.Doc stays empty) so the caller falls through to cloud sync.
 * The writer is expected to have set WAL on the file so concurrent
 * readers get snapshot pages without `SQLITE_BUSY`.
 *
 * Construction is synchronous: `existsSync` + open + replay all run on
 * the calling tick. The Y.Doc is fully hydrated by the time this
 * function returns; no `whenLoaded` field.
 */

import { existsSync } from 'node:fs';
import { Database } from 'bun:sqlite';
import * as Y from 'yjs';

export type YjsLogReaderAttachment = {
	/**
	 * `true` if the file existed at open time and rows were replayed;
	 * `false` if the daemon has not written here yet. Snapshot value,
	 * taken once at construction; the file is not re-checked later.
	 */
	fileExisted: boolean;
	/**
	 * Resolves after `ydoc.destroy()` AND `db.close()`. No final compaction
	 * (the reader never wrote). Opt-in: tests and CLIs flushing before
	 * exit await this.
	 */
	whenDisposed: Promise<unknown>;
};

/**
 * Open the writer's file `{ readonly: true }` and replay every row into
 * the Y.Doc. Returns the open db handle so the caller can close it on
 * destroy. File-doesn't-exist is the cold path: caller short-circuits.
 */
function openAndReplay(filePath: string, ydoc: Y.Doc): Database {
	const db = new Database(filePath, { readonly: true });
	// File is owned by the writer. No CREATE TABLE, no journal_mode pragma
	// (the writer set WAL), no updateV2 listener, no compaction: pure
	// snapshot consumer. We do set `busy_timeout` so a reader opening
	// mid-checkpoint waits instead of surfacing SQLITE_BUSY.
	db.run('PRAGMA busy_timeout = 5000');
	// bun:sqlite returns BLOB columns as Uint8Array; Y.applyUpdateV2
	// accepts Uint8Array directly.
	const rows = db.query('SELECT data FROM updates ORDER BY id').all() as {
		data: Uint8Array;
	}[];
	for (const row of rows) {
		Y.applyUpdateV2(ydoc, row.data);
	}
	return db;
}

export function attachYjsLogReader(
	ydoc: Y.Doc,
	{ filePath }: { filePath: string },
): YjsLogReaderAttachment {
	const fileExisted = existsSync(filePath);
	const db = fileExisted ? openAndReplay(filePath, ydoc) : undefined;

	const { promise: whenDisposed, resolve: resolveDisposed } =
		Promise.withResolvers<void>();

	ydoc.once('destroy', () => {
		try {
			db?.close();
		} finally {
			resolveDisposed();
		}
	});

	return {
		fileExisted,
		whenDisposed,
	};
}
