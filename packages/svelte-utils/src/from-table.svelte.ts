import type {
	BaseRow,
	ReadonlyTable,
	TableNewerWriterError,
	TableParseError,
	TableUnreadableError,
} from '@epicenter/workspace';
import { SvelteMap } from 'svelte/reactivity';

/**
 * A reactive `SvelteMap` of a table's conforming rows, with the table's three
 * issue buckets attached as debounced properties.
 *
 * The map itself is the hot surface: `get`, `has`, `size`, and iteration all
 * update granularly per changed row. The issue buckets (`nonconforming`,
 * `newerWriter`, `unreadable`) recompute on a debounce, because they change
 * rarely (a schema edit, a sync from a newer build, a key change) while rows
 * change on every keystroke.
 */
export type ReactiveTableMap<TRow extends BaseRow> = SvelteMap<string, TRow> &
	Disposable & {
		/** Stored entries this binary should understand but cannot parse. */
		readonly nonconforming: TableParseError[];
		/** Stored entries written by a newer binary than this one. */
		readonly newerWriter: TableNewerWriterError[];
		/** Encrypted entries this device holds no usable key for. */
		readonly unreadable: TableUnreadableError[];
	};

/**
 * Create a reactive binding to a workspace table from a single `observe()`
 * subscription.
 *
 * The returned value is a `SvelteMap<id, Row>` of the conforming rows that
 * stays in sync via granular per-row updates: only changed rows trigger
 * re-renders, not the entire collection. The same subscription also exposes the
 * three issue buckets (`nonconforming`, `newerWriter`, `unreadable`) as
 * debounced properties, so a view can surface what the rows hide without a
 * second subscription. Buckets are recomputed via a full `scan()` on a debounce
 * because they change rarely; rows stay granular because they change often.
 *
 * Read-only: mutations go through `table.set()`, `table.update()`, etc. The
 * observer picks up changes from both local writes and remote CRDT sync.
 *
 * The returned map is disposable. Call `[Symbol.dispose]()` when the binding
 * has a shorter lifetime than the workspace, such as component teardown,
 * workspace switching, HMR, or tests.
 *
 * @example
 * ```typescript
 * const entries = fromTable(workspaceClient.tables.entries);
 *
 * // Per-item access (reactive):
 * const entry = entries.get(id);
 *
 * // Iterate the conforming rows (reactive):
 * for (const [id, entry] of entries) { ... }
 *
 * // Issue buckets (reactive, debounced):
 * entries.nonconforming.length;
 * entries.newerWriter.length;
 * entries.unreadable.length;
 *
 * // Teardown:
 * entries[Symbol.dispose]();
 * ```
 */
export function fromTable<TRow extends BaseRow>(
	table: ReadonlyTable<TRow>,
	{ debounceMs = 100 }: { debounceMs?: number } = {},
): ReactiveTableMap<TRow> {
	const map = new SvelteMap<string, TRow>();

	// Seed both surfaces from one scan: the conforming rows into the map, the
	// issue buckets into the debounced state.
	const initial = table.scan();
	for (const row of initial.rows) map.set(row.id, row);

	let nonconforming = $state.raw<TableParseError[]>(initial.nonconforming);
	let newerWriter = $state.raw<TableNewerWriterError[]>(initial.newerWriter);
	let unreadable = $state.raw<TableUnreadableError[]>(initial.unreadable);
	let timer: ReturnType<typeof setTimeout> | undefined;

	const unobserve = table.observe((changedIds) => {
		// Granular per-row updates: only touch changed rows. A row that goes
		// unreadable, nonconforming, newer-stamped, or deleted leaves the map.
		for (const id of changedIds) {
			const { data: row, error } = table.get(id);
			if (error || row === null) {
				map.delete(id);
				continue;
			}
			map.set(id, row);
		}
		// Debounced full re-scan for the issue buckets. They change rarely, so a
		// debounced rebuild is the right cost trade against a per-change rescan.
		clearTimeout(timer);
		timer = setTimeout(() => {
			const scan = table.scan();
			nonconforming = scan.nonconforming;
			newerWriter = scan.newerWriter;
			unreadable = scan.unreadable;
		}, debounceMs);
	});

	let disposed = false;
	Object.defineProperties(map, {
		nonconforming: { get: () => nonconforming, enumerable: false },
		newerWriter: { get: () => newerWriter, enumerable: false },
		unreadable: { get: () => unreadable, enumerable: false },
		[Symbol.dispose]: {
			value() {
				if (disposed) return;
				disposed = true;
				clearTimeout(timer);
				unobserve();
			},
			enumerable: false,
		},
	});

	return map as ReactiveTableMap<TRow>;
}
