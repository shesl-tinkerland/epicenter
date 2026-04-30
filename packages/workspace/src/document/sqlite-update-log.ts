/**
 * Shared append-log compaction helper for SQLite-backed Y.Doc persistence.
 *
 * Both `attachYjsLog(ydoc, { filePath })` (per-doc,
 * document-layer) and `sqlitePersistence({ filePath })` (workspace-scope
 * extension) use the same append-log strategy: every `updateV2` becomes a
 * tiny `INSERT INTO updates (data) VALUES (?)`, and periodically the log
 * is compacted into a single row encoded via `Y.encodeStateAsUpdateV2`.
 *
 * The constants and the helper live here so both consumers share one source
 * of truth. Drift between the two previously caused silent behavior skew.
 */

import type { Database } from 'bun:sqlite';
import * as Y from 'yjs';

/** Max compacted update size (2 MB). Matches the Cloudflare DO limit. */
export const MAX_COMPACTED_BYTES = 2 * 1024 * 1024;

/**
 * Compact when accumulated incremental updates exceed this size.
 *
 * Targets the real problem: large row replacements (e.g. 30 KB autosaves)
 * accumulating over long desktop sessions. At 2 MB the log is guaranteed to
 * be 10-50× larger than the compact doc for typical workloads. Low enough
 * to prevent multi-MB logs; high enough to ignore thousands of tiny
 * keystroke updates that total only a few hundred KB.
 */
export const COMPACTION_BYTE_THRESHOLD = 2 * 1024 * 1024;

/**
 * Debounce compaction by 5 s after the byte threshold is crossed.
 *
 * Prevents compacting during a burst of rapid writes (e.g. bulk import).
 * The compaction itself is fast (~16 ms for 10 K rows) but we don't want
 * to interrupt a hot write path.
 */
export const COMPACTION_DEBOUNCE_MS = 5_000;

/**
 * Compact the SQLite update log into a single row.
 *
 * Encodes the current doc state via `Y.encodeStateAsUpdateV2`: produces
 * smaller output than merging individual updates. No-ops if the log
 * already has ≤ 1 row or the compacted blob exceeds 2 MB.
 *
 * @returns `true` if compaction ran, `false` if it no-oped.
 */
export function compactUpdateLog(db: Database, ydoc: Y.Doc): boolean {
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
