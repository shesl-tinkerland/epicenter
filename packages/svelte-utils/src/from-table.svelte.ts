import type {
	BaseRow,
	ReadonlyTable,
	Table,
	TableConformance,
} from '@epicenter/workspace';
import { SvelteMap } from 'svelte/reactivity';

/**
 * Create a reactive SvelteMap binding to a workspace table.
 *
 * Returns a `SvelteMap<id, Row>` that stays in sync with the underlying
 * Yjs table via granular per-row updates. Only changed rows trigger
 * re-renders, not the entire collection.
 *
 * Read-only: mutations go through `table.set()`, `table.update()`, etc.
 * The observer picks up changes from both local writes and remote CRDT sync.
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
 * // Iterate (reactive):
 * for (const [id, entry] of entries) { ... }
 *
 * // Array access:
 * const all = [...entries.values()];
 *
 * // Derived state:
 * const filtered = $derived([...entries.values()].filter(e => !e.deletedAt));
 *
 * // Teardown:
 * entries[Symbol.dispose]();
 * ```
 */
export function fromTable<TRow extends BaseRow>(table: Table<TRow>) {
	const map = new SvelteMap<string, TRow>() as SvelteMap<string, TRow> &
		Disposable;

	// Seed with current valid rows
	for (const row of table.getAllValid()) {
		map.set(row.id, row);
	}

	// Granular updates: only touch changed rows
	const unobserve = table.observe((changedIds) => {
		for (const id of changedIds) {
			const { data: row, error } = table.get(id);
			if (error || row === null) {
				// This map only exposes valid rows. Invalid stored data and missing
				// rows both leave the reactive view.
				map.delete(id);
				continue;
			}

			map.set(id, row);
		}
	});
	let disposed = false;

	Object.defineProperty(map, Symbol.dispose, {
		value() {
			if (disposed) return;
			disposed = true;
			unobserve();
		},
		enumerable: false,
	});

	return map;
}

export type ReactiveTableMap<TRow extends BaseRow> = ReturnType<
	typeof fromTable<TRow>
>;

/**
 * Create a reactive binding to a table's conformance snapshot.
 *
 * `table.conformance()` is a full scan plus validation (same cost as
 * `getAllValid()`), so this helper recomputes on the table's `observe()`
 * signal with a debounce instead of on every render.
 *
 * Works against the readonly surface: read-only consumers can render the
 * queue even though repair (`set()` / `delete()`) needs a writable table.
 *
 * The returned binding is disposable; call `[Symbol.dispose]()` on
 * component teardown, workspace switching, HMR, or tests.
 *
 * @example
 * ```typescript
 * const conformance = fromTableConformance(workspace.tables.entries);
 *
 * // Reactive reads:
 * conformance.current.valid;
 * conformance.current.nonconforming.length;
 * conformance.current.newerWriter.length;
 *
 * // Teardown:
 * conformance[Symbol.dispose]();
 * ```
 */
export function fromTableConformance<TRow extends BaseRow>(
	table: ReadonlyTable<TRow>,
	{ debounceMs = 100 }: { debounceMs?: number } = {},
) {
	let current = $state.raw<TableConformance>(table.conformance());
	let timer: ReturnType<typeof setTimeout> | undefined;

	const unobserve = table.observe(() => {
		clearTimeout(timer);
		timer = setTimeout(() => {
			current = table.conformance();
		}, debounceMs);
	});

	return {
		get current() {
			return current;
		},
		[Symbol.dispose]() {
			clearTimeout(timer);
			unobserve();
		},
	};
}

export type ReactiveTableConformance = ReturnType<
	typeof fromTableConformance
>;
