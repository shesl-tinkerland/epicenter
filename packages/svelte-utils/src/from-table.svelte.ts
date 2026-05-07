import type { BaseRow, Table } from '@epicenter/workspace';
import { createSubscriber } from 'svelte/reactivity';

/** Create a reactive readonly view over a workspace table. */
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
