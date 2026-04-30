/**
 * Standard concurrency PRAGMAs for the writer side of the project's
 * many-readers + one-writer SQLite design.
 *
 * Both `attachYjsLog` (the Y.Doc update-log writer) and `attachSqlite`
 * (the queryable projection writer) sit on the same axis: a single daemon
 * writes the file, many script peers open it `{ readonly: true }` and
 * snapshot-read in parallel. The PRAGMA triple below is what makes that
 * work, and it's the same triple in every writer.
 *
 * Source-of-truth motivation (not DRY): if we change the rule (add
 * `wal_autocheckpoint`, tune the busy timeout, harden the WAL
 * verification), every writer-side SQLite file in the project must pick
 * up the change in lockstep. The rule lives in this codebase, not in an
 * external standard, so it earns one home.
 */

import type { Database } from 'bun:sqlite';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import type { Logger } from 'wellcrafted/logger';
import { trySync } from 'wellcrafted/result';

/**
 * Errors surfaced by `applyWriterPragmas`. Each pragma is best-effort:
 * `:memory:` and some test setups reject WAL, and the writer continues
 * with driver defaults rather than failing the attachment.
 */
export const SqliteWriterPragmaError = defineErrors({
	/** A specific PRAGMA failed to apply, or `journal_mode` silently fell back. */
	PragmaSetupFailed: ({
		pragma,
		cause,
	}: { pragma: string; cause: unknown }) => ({
		message: `[sqlite-writer-pragmas] PRAGMA ${pragma} failed: ${extractErrorMessage(cause)}`,
		pragma,
		cause,
	}),
});
export type SqliteWriterPragmaError = InferErrors<
	typeof SqliteWriterPragmaError
>;

/**
 * Apply the standard concurrency PRAGMAs:
 *
 *   journal_mode = WAL    enables MVCC snapshot reads while we write.
 *   synchronous = NORMAL  the canonical durability tradeoff under WAL.
 *   busy_timeout = 5000   waits on SQLITE_BUSY instead of surfacing it.
 *
 * `journal_mode = WAL` does not throw on silent fallback (e.g. on a
 * filesystem that doesn't support WAL); it just returns the mode that
 * actually got set. We read the result and warn if it isn't `'wal'`.
 *
 * Caller passes its own logger so failures surface under the caller's
 * source label (`attachYjsLog`, `attachSqlite`, etc.) rather than this
 * helper's name.
 */
export function applyWriterPragmas(db: Database, log: Logger): void {
	const walResult = trySync({
		try: () =>
			(
				db
					.query('PRAGMA journal_mode = WAL')
					.get() as { journal_mode?: string } | null
			)?.journal_mode,
		catch: (cause) =>
			SqliteWriterPragmaError.PragmaSetupFailed({
				pragma: 'journal_mode = WAL',
				cause,
			}),
	});
	if (walResult.error !== null) {
		log.warn(walResult.error);
	} else if (walResult.data !== 'wal') {
		log.warn(
			SqliteWriterPragmaError.PragmaSetupFailed({
				pragma: 'journal_mode = WAL',
				cause: new Error(
					`PRAGMA journal_mode returned '${walResult.data}', expected 'wal'`,
				),
			}),
		);
	}

	const syncResult = trySync({
		try: () => db.run('PRAGMA synchronous = NORMAL'),
		catch: (cause) =>
			SqliteWriterPragmaError.PragmaSetupFailed({
				pragma: 'synchronous = NORMAL',
				cause,
			}),
	});
	if (syncResult.error !== null) log.warn(syncResult.error);

	const busyResult = trySync({
		try: () => db.run('PRAGMA busy_timeout = 5000'),
		catch: (cause) =>
			SqliteWriterPragmaError.PragmaSetupFailed({
				pragma: 'busy_timeout = 5000',
				cause,
			}),
	});
	if (busyResult.error !== null) log.warn(busyResult.error);
}
