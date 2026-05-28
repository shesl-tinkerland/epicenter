import { fromTable } from '@epicenter/svelte';
import type { FujiBrowser } from '../../fuji.browser';
import type { EntryId } from '../../fuji.workspace';

/**
 * Reactive entries selectors derived from the fuji binding's entries table.
 *
 * Components read this through `requireFuji().entries`; the active and
 * deleted lists update reactively as entries change. Disposed alongside the
 * session.
 */
export function createEntriesState(fuji: FujiBrowser) {
	const entriesMap = fromTable(fuji.tables.entries);
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
		[Symbol.dispose]() {
			entriesMap[Symbol.dispose]();
		},
	};
}
