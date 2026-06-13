import { fromTable, fromTableConformance } from '@epicenter/svelte';
import type { EntryId } from '$lib/workspace';
import type { FujiBrowser } from '$lib/workspace/browser';

/**
 * Reactive entries selectors derived from the fuji binding's entries table.
 *
 * Components read this through `requireFuji().entries`; the active and
 * deleted lists update reactively as entries change. `conformance` exposes
 * the rows those lists hide: entries that fail the current schema or were
 * written by a newer Fuji. Disposed alongside the session.
 */
export function createEntriesState(fuji: FujiBrowser) {
	const entriesMap = fromTable(fuji.tables.entries);
	const conformance = fromTableConformance(fuji.tables.entries);
	const active = $derived(
		[...entriesMap.values()].filter((e) => e.deletedAt === null),
	);
	const deleted = $derived(
		[...entriesMap.values()].filter((e) => e.deletedAt !== null),
	);
	return {
		get: (id: EntryId) => entriesMap.get(id),
		get active() {
			return active;
		},
		get deleted() {
			return deleted;
		},
		get conformance() {
			return conformance.current;
		},
		[Symbol.dispose]() {
			conformance[Symbol.dispose]();
			entriesMap[Symbol.dispose]();
		},
	};
}
