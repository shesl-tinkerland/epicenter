import type { BaseRow, Table } from '@epicenter/workspace';
import { createSubscriber } from 'svelte/reactivity';

/**
 * Create a reactive readonly view over a workspace table.
 *
 * The returned view reads live Yjs state on every access. Reading `all` or
 * `byId(id)` inside a Svelte effect subscribes to table updates; outside an
 * effect, the same access returns current data without opening an observer.
 *
 * @example
 * ```typescript
 * const entries = fromTable(workspaceClient.tables.entries);
 *
 * const all = $derived(entries.all);
 * const selected = $derived(entries.byId(selectedId));
 * ```
 */
export function fromTable<TRow extends BaseRow>(table: Table<TRow>) {
	const subscribe = createSubscriber((update) => table.observe(update));

	return {
		get all(): TRow[] {
			subscribe();
			return table.getAllValid();
		},
		byId(id: string): TRow | undefined {
			subscribe();
			return table.get(id).data ?? undefined;
		},
	};
}
