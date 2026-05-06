/**
 * Reactive Fuji entry state and search helpers.
 *
 * Built once per <SignedIn> mount, exposed via context. Lifetime is
 * coterminous with the workspace handle: same gate that opens the
 * workspace creates this state and disposes it on unmount.
 *
 * @example
 * ```svelte
 * <script>
 *   import { getEntriesState, matchesEntrySearch } from '../state/entries.svelte';
 *   const entriesState = getEntriesState();
 * </script>
 * ```
 */

import { fromTable } from '@epicenter/svelte';
import { createContext } from 'svelte';
import { goto } from '$app/navigation';
import type { Fuji } from '../fuji/browser';
import type { Entry, EntryId } from '../fuji/workspace';

// Search

/**
 * Test whether an entry matches a search query.
 *
 * Checks title, subtitle, tags, and type fields against a
 * case-insensitive substring match. Returns true if any field
 * contains the query.
 */
export function matchesEntrySearch(
	entry: Pick<Entry, 'title' | 'subtitle' | 'tags' | 'type'>,
	query: string,
): boolean {
	const q = query.trim().toLowerCase();
	if (!q) return false;
	const title = entry.title.toLowerCase();
	const subtitle = entry.subtitle.toLowerCase();
	const tags = entry.tags.join(' ').toLowerCase();
	const types = entry.type.join(' ').toLowerCase();
	return (
		title.includes(q) ||
		subtitle.includes(q) ||
		tags.includes(q) ||
		types.includes(q)
	);
}

// Entries state

export function createEntriesState(fuji: Fuji) {
	const map = fromTable(fuji.tables.entries);
	const all = $derived([...map.values()]);
	const active = $derived(all.filter((e) => e.deletedAt === undefined));
	const deleted = $derived(all.filter((e) => e.deletedAt !== undefined));

	return {
		[Symbol.dispose]() {
			map[Symbol.dispose]();
		},

		/** Look up an entry by ID. Returns `undefined` if not found. */
		get(id: EntryId) {
			return map.get(id);
		},

		/** Active entries, not soft-deleted. Computed once per change cycle. */
		get active() {
			return active;
		},

		/** Soft-deleted entries, has `deletedAt` set. Computed once per change cycle. */
		get deleted() {
			return deleted;
		},

		/**
		 * Create a new entry with sensible defaults and navigate to it.
		 *
		 * Delegates to the workspace `entries.create` action, then
		 * navigates to `/entries/{id}` so the editor opens immediately.
		 */
		createEntry() {
			const { id } = fuji.actions.entries.create({});
			goto(`/entries/${id}`);
		},
	};
}

export type EntriesState = ReturnType<typeof createEntriesState>;
export const [getEntriesState, setEntriesState] =
	createContext<EntriesState>();
