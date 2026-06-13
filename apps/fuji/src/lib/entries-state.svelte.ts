import { fromTable } from '@epicenter/svelte';
import type { EntryId } from '$lib/workspace';
import type { FujiBrowser } from '$lib/workspace/browser';

/**
 * Reactive entries selectors derived from the fuji binding's entries table.
 *
 * Components read this through `requireFuji().entries`; the active and deleted
 * lists update reactively as entries change. The conformance getters expose the
 * rows those lists hide: entries that fail the current schema, were written by
 * a newer Fuji, or are encrypted with a key this device does not have. One
 * `fromTable` binding drives both the row map and the issue buckets from a
 * single subscription. Disposed alongside the session.
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
		/** Count of entries that parse and match the current schema. */
		get conforming() {
			return entriesMap.size;
		},
		/** Entries this Fuji should understand but cannot parse. */
		get nonconforming() {
			return entriesMap.nonconforming;
		},
		/** Entries written by a newer version of Fuji. */
		get newerWriter() {
			return entriesMap.newerWriter;
		},
		/** Entries encrypted with a key this device does not have. */
		get unreadable() {
			return entriesMap.unreadable;
		},
		[Symbol.dispose]() {
			entriesMap[Symbol.dispose]();
		},
	};
}
