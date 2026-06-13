/**
 * SQLite materializer core: the internal body wrapped by
 * `attachBunSqliteMaterializer`. Mirrors workspace table rows into a
 * SQLite mirror via a `bun:sqlite` database.
 *
 * Public callers use `attachBunSqliteMaterializer`, which owns the native
 * client lifecycle and forwards the client here.
 *
 * Teardown is hooked to the ydoc via `ydoc.once('destroy', ...)`. Core drains
 * pending mirror work (initial full-load, debounced row flush) bounded by
 * `disposeTimeoutMs`, then closes the underlying native client; the barrier is
 * surfaced as `whenDisposed`.
 *
 * @internal
 * @module
 */

import type { Database, SQLQueryBindings } from 'bun:sqlite';
import { debounce } from '@epicenter/util';
import Type from 'typebox';
import { defineErrors, extractErrorMessage } from 'wellcrafted/error';
import { createLogger, type Logger } from 'wellcrafted/logger';
import type * as Y from 'yjs';
import { defineActions, defineMutation } from '../../../shared/actions.js';
import type { BaseRow, Table } from '../../table.js';
import { type AnyTable, settledWithin, type TablesRecord } from '../shared.js';
import { generateDdl, quoteIdentifier } from './ddl.js';
import { createSqliteFtsLayer } from './fts.js';

/**
 * Optional FTS configuration, keyed by the same names as `tables`. Each
 * value lists the columns of that table's row to include in the FTS5 index.
 *
 * The mapped type narrows the value to the row's column names, so typos
 * become compile errors at the call site.
 */
export type FtsConfig<TTables extends TablesRecord> = {
	[K in keyof TTables]?: TTables[K] extends Table<infer TRow>
		? (keyof TRow & string)[]
		: never;
};

/** Errors surfaced by the SQLite materializer's async database work queue. */
const SqliteMaterializerError = defineErrors({
	/** Debounced flush of pending row writes to the mirror database failed. */
	SyncFailed: ({ cause }: { cause: unknown }) => ({
		message: `[sqlite-materializer] Failed to sync SQLite materializer: ${extractErrorMessage(cause)}`,
		cause,
	}),
	/** Post-queue disposal tail failed after the materializer detached. */
	DisposeFailed: ({ cause }: { cause: unknown }) => ({
		message: `[sqlite-materializer] Failed to dispose SQLite materializer: ${extractErrorMessage(cause)}`,
		cause,
	}),
	/** Teardown drain hit its bound; the database closes with work pending. */
	DrainTimedOut: ({ timeoutMs }: { timeoutMs: number }) => ({
		message: `[sqlite-materializer] teardown drain did not settle within ${timeoutMs}ms; closing with work pending`,
		timeoutMs,
	}),
	/**
	 * A full-load `scan()` surfaced entries that will not mirror into SQLite:
	 * rows the binary cannot parse, rows from a newer writer, or undecryptable
	 * rows. The full load mirrors only `scan().rows`; this records what it
	 * skipped so the gap is in the log rather than silent.
	 */
	NonconformingRowsSkipped: ({
		tableName,
		nonconforming,
		newerWriter,
		unreadable,
	}: {
		tableName: string;
		nonconforming: number;
		newerWriter: number;
		unreadable: number;
	}) => ({
		message: `[sqlite-materializer] "${tableName}" skipped rows that did not mirror: ${nonconforming} nonconforming, ${newerWriter} from a newer writer, ${unreadable} unreadable`,
		tableName,
		nonconforming,
		newerWriter,
		unreadable,
	}),
});

type RegisteredTable = {
	table: AnyTable;
	unsubscribe?: () => void;
};

/**
 * Internal shared materializer body. `attachBunSqliteMaterializer` forwards
 * its native client to this function.
 *
 * Callers outside this directory should not import this directly.
 *
 * @internal
 */
export function attachSqliteMaterializerCore<
	TTables extends TablesRecord,
	TFts extends FtsConfig<TTables> | undefined = undefined,
>(
	ydoc: Y.Doc,
	{
		db,
		tables,
		fts,
		debounceMs = 100,
		waitFor,
		disposeTimeoutMs = 10_000,
		log = createLogger('sqlite-materializer'),
	}: {
		db: Database;
		/**
		 * Workspace tables to mirror. Each entry becomes a SQLite table named
		 * after the record key.
		 */
		tables: TTables;
		/**
		 * Optional FTS5 configuration. Keyed by the same names as `tables`,
		 * with values listing the columns to include in the FTS index. When
		 * provided, the `actions` registry gains a `sqlite_search` action; when
		 * omitted, only `sqlite_rebuild` is present.
		 */
		fts?: TFts;
		debounceMs?: number;
		/**
		 * Gate: the materializer awaits this before the initial DDL + full-load.
		 * Matches the `waitFor` convention used by `openCollaboration`. Omit
		 * for no gate.
		 */
		waitFor?: Promise<unknown>;
		/**
		 * Upper bound on the teardown drain: dispose waits at most this long
		 * for the initial full-load and the pending row flush to settle before
		 * closing the database, so a hung statement cannot wedge shutdown.
		 * Defaults to 10 seconds.
		 */
		disposeTimeoutMs?: number;
		/**
		 * Logger for background failures (debounced sync flush, FTS query).
		 * Defaults to a console-backed logger with source `sqlite-materializer`.
		 */
		log?: Logger;
	},
) {
	const registered = new Map<string, RegisteredTable>();
	for (const [tableName, table] of Object.entries(tables)) {
		registered.set(tableName, { table: table as AnyTable });
	}

	// FTS lives entirely in its own layer when configured. Core knows nothing
	// about FTS state, columns, or search SQL.
	const ftsLayer =
		fts !== undefined
			? createSqliteFtsLayer<TTables>({ db, fts, log })
			: undefined;

	let pendingSync = new Map<string, Set<string>>();
	let dbQueue = Promise.resolve();
	let isDisposed = false;
	// The `waitFor` gate has resolved, so the initial DDL + full-load is
	// underway (or done) and teardown owes it a drain. Disposing while the
	// gate is still closed owes nothing: the load never started, and
	// `initialize` bails when the gate finally opens.
	let isGateOpen = waitFor === undefined;
	let isFlushAbandoned = false;

	// ── SQL primitives ───────────────────────────────────────────

	async function insertRow(
		tableName: string,
		row: BaseRow & Record<string, unknown>,
	) {
		const keys = Object.keys(row);
		const values = keys.map((key) => serializeValue(row[key])) as [
			SQLQueryBindings,
			...SQLQueryBindings[],
		];

		const stmt = await db.prepare(buildUpsertSql(tableName, keys));
		await stmt.run(...values);
	}

	async function deleteRow(tableName: string, id: string) {
		const stmt = await db.prepare(
			`DELETE FROM ${quoteIdentifier(tableName)} WHERE ${quoteIdentifier('id')} = ?`,
		);
		await stmt.run(id);
	}

	async function fullLoadTable(tableName: string, table: AnyTable) {
		const scan = table.scan();
		if (
			scan.nonconforming.length > 0 ||
			scan.newerWriter.length > 0 ||
			scan.unreadable.length > 0
		) {
			log.warn(
				SqliteMaterializerError.NonconformingRowsSkipped({
					tableName,
					nonconforming: scan.nonconforming.length,
					newerWriter: scan.newerWriter.length,
					unreadable: scan.unreadable.length,
				}),
			);
		}
		const rows = scan.rows;
		if (rows.length === 0) return;

		const keys = collectRowKeys(rows);
		const stmt = await db.prepare(buildUpsertSql(tableName, keys));

		for (const row of rows) {
			const values = keys.map((key) => serializeValue(row[key])) as [
				SQLQueryBindings,
				...SQLQueryBindings[],
			];
			await stmt.run(...values);
		}
	}

	// ── Sync engine ──────────────────────────────────────────────

	function enqueueDbWork(work: () => Promise<void>): Promise<void> {
		const result = dbQueue.then(work);
		dbQueue = result.catch(() => {});
		return result;
	}

	const flushAfterDebounce = debounce(() => {
		void enqueueDbWork(flushPendingSync).catch((cause: unknown) => {
			log.error(SqliteMaterializerError.SyncFailed({ cause }));
		});
	}, debounceMs);

	function scheduleSync(tableName: string, changedIds: ReadonlySet<string>) {
		if (isDisposed) return;

		let tableIds = pendingSync.get(tableName);
		if (tableIds === undefined) {
			tableIds = new Set<string>();
			pendingSync.set(tableName, tableIds);
		}

		for (const id of changedIds) tableIds.add(id);

		flushAfterDebounce();
	}

	async function flushPendingSync() {
		const currentPending = pendingSync;
		pendingSync = new Map<string, Set<string>>();

		for (const [tableName, ids] of currentPending) {
			const entry = registered.get(tableName);
			if (entry === undefined) continue;

			for (const id of ids) {
				const { data: row, error } = entry.table.get(id);
				if (error || row === null) {
					// Invalid or missing → drop from mirror.
					await deleteRow(tableName, id);
					continue;
				}
				await insertRow(tableName, row);
			}
		}
	}

	// ── Mutation surface ─────────────────────────────────────────

	async function rebuild(tableName?: string): Promise<void> {
		if (isDisposed) return;

		if (tableName !== undefined) {
			const entry = registered.get(tableName);
			if (entry === undefined) {
				throw new Error(
					`Cannot rebuild "${tableName}": not in the materialized table set.`,
				);
			}

			return enqueueDbWork(async () => {
				if (isDisposed) return;

				await db.run('BEGIN');
				try {
					await db.run(`DELETE FROM ${quoteIdentifier(tableName)}`);
					await fullLoadTable(tableName, entry.table);
					await db.run('COMMIT');
				} catch (error: unknown) {
					await db.run('ROLLBACK');
					throw error;
				}
			});
		}

		return enqueueDbWork(async () => {
			if (isDisposed) return;

			await db.run('BEGIN');
			try {
				for (const [name] of registered)
					await db.run(`DELETE FROM ${quoteIdentifier(name)}`);
				for (const [name, entry] of registered)
					await fullLoadTable(name, entry.table);
				await db.run('COMMIT');
			} catch (error: unknown) {
				await db.run('ROLLBACK');
				throw error;
			}
		});
	}

	// ── Disposal ────────────────────────────────────────────────

	const { promise: whenDisposed, resolve: resolveDisposed } =
		Promise.withResolvers<void>();

	function dispose() {
		if (isDisposed) return;
		isDisposed = true;
		isFlushAbandoned = !isGateOpen;
		flushAfterDebounce.cancel();
		for (const entry of registered.values()) entry.unsubscribe?.();

		// Drain pending projection work before closing: the initial DDL +
		// full-load (unless its gate never opened) and any rows still sitting
		// in the debounced pending set. Bounded so a hung statement cannot
		// wedge shutdown; on timeout the database closes with work pending.
		void (async () => {
			const drain = (async () => {
				if (!isFlushAbandoned) await whenFlushed.catch(() => {});
				await enqueueDbWork(flushPendingSync).catch((cause: unknown) => {
					log.error(SqliteMaterializerError.SyncFailed({ cause }));
				});
			})();
			const didSettle = await settledWithin(drain, disposeTimeoutMs);
			if (!didSettle) {
				log.warn(
					SqliteMaterializerError.DrainTimedOut({
						timeoutMs: disposeTimeoutMs,
					}),
				);
			}
			await db.close();
		})()
			.catch((cause: unknown) => {
				log.error(SqliteMaterializerError.DisposeFailed({ cause }));
			})
			.finally(resolveDisposed);
	}

	ydoc.once('destroy', dispose);

	// ── Initial flush ────────────────────────────────────────────

	async function initialize() {
		// Always yield a microtask so callers can seed synchronous writes
		// (e.g. `tables.posts.set(...)`) before the full-load reads
		// `scan().rows`.
		await waitFor;
		isGateOpen = true;
		if (isFlushAbandoned) return;

		await enqueueDbWork(async () => {
			for (const [tableName, entry] of registered) {
				await db.run(generateDdl(tableName, entry.table.schema));
			}

			if (ftsLayer !== undefined) {
				// FTS triggers must exist before the bulk insert so full-load rows
				// populate `<table>_fts` through the normal INSERT triggers.
				await ftsLayer.setupForBulkLoad();
			}

			await db.run('BEGIN');
			try {
				for (const [tableName, entry] of registered)
					await fullLoadTable(tableName, entry.table);
				await db.run('COMMIT');
			} catch (error: unknown) {
				await db.run('ROLLBACK');
				throw error;
			}
		});

		// Disposed mid-load: the writes above are owed (the teardown drain
		// awaits this whole flush), but no observer may outlive teardown.
		if (isDisposed) return;

		for (const [tableName, entry] of registered) {
			entry.unsubscribe = entry.table.observe((changedIds) => {
				scheduleSync(tableName, changedIds);
			});
		}
	}

	const whenFlushed = initialize();

	// Every wire-exposed operation lives in one `actions` registry, mirroring
	// the markdown materializer so a mount spreads `...sqlite.actions`.
	// `sqlite_rebuild` is always present; `sqlite_search` only when an FTS index
	// was configured. Two literal branches keep each registry key required
	// (an optional key would not satisfy the ActionRegistry constraint).
	const rebuildAction = defineMutation({
		title: 'Rebuild SQLite mirror',
		description:
			'Drop and rebuild the materialized SQLite tables from the Yjs source. Optionally limit to one table.',
		input: Type.Object({
			table: Type.Optional(
				Type.String({
					description: 'Limit rebuild to one table; omit for all tables.',
				}),
			),
		}),
		handler: ({ table: tableName }) => rebuild(tableName),
	});

	const actions = ftsLayer
		? defineActions({
				sqlite_rebuild: rebuildAction,
				sqlite_search: ftsLayer.search,
			})
		: defineActions({ sqlite_rebuild: rebuildAction });

	return {
		whenFlushed,
		/**
		 * Resolves after `ydoc.destroy()` once pending mirror work (the initial
		 * full-load and the debounced row flush) has drained and the database
		 * handle is closed, bounded by `disposeTimeoutMs`. Daemon teardown
		 * awaits this before process exit so a shutdown cannot drop mirror
		 * writes mid-flight.
		 */
		whenDisposed,
		actions,
	};
}

// ════════════════════════════════════════════════════════════════════════════
// MODULE-LEVEL HELPERS
// ════════════════════════════════════════════════════════════════════════════

/**
 * Build an UPSERT statement: insert with `ON CONFLICT(id) DO UPDATE`.
 *
 * Avoids `INSERT OR REPLACE` so updates preserve standard UPSERT semantics.
 * Standard UPSERT works across SQLite-compatible engines and keeps this helper
 * portable for tests.
 *
 * When `keys.length === 1` (just `id`), there's nothing to update on
 * conflict, so the statement collapses to `INSERT ... ON CONFLICT DO NOTHING`
 * (SET clauses with zero assignments are a SQL error).
 */
function buildUpsertSql(tableName: string, keys: string[]): string {
	const quotedTable = quoteIdentifier(tableName);
	const columns = keys.map(quoteIdentifier).join(', ');
	const placeholders = keys.map(() => '?').join(', ');
	const updateKeys = keys.filter((key) => key !== 'id');

	if (updateKeys.length === 0) {
		return `INSERT INTO ${quotedTable} (${columns}) VALUES (${placeholders}) ON CONFLICT(${quoteIdentifier('id')}) DO NOTHING`;
	}

	const setClause = updateKeys
		.map((key) => `${quoteIdentifier(key)} = excluded.${quoteIdentifier(key)}`)
		.join(', ');

	return `INSERT INTO ${quotedTable} (${columns}) VALUES (${placeholders}) ON CONFLICT(${quoteIdentifier('id')}) DO UPDATE SET ${setClause}`;
}

function collectRowKeys(rows: readonly BaseRow[]): string[] {
	const keys = new Set<string>();
	for (const row of rows) {
		for (const key of Object.keys(row)) keys.add(key);
	}
	return [...keys];
}

/**
 * Convert a workspace row value into a SQLite-compatible value.
 *
 * - `null` / `undefined` → SQL `NULL`
 * - `object` / `array` → JSON string (`TEXT` column)
 * - `boolean` → `0` or `1` (`INTEGER` column)
 * - everything else → passed through as-is
 */
function serializeValue(value: unknown): SQLQueryBindings {
	if (value === null || value === undefined) return null;
	if (typeof value === 'object') return JSON.stringify(value) ?? null;
	if (typeof value === 'boolean') return value ? 1 : 0;
	if (
		typeof value === 'string' ||
		typeof value === 'number' ||
		typeof value === 'bigint'
	) {
		return value;
	}
	return String(value);
}
