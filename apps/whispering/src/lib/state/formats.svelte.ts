/**
 * Reactive Format state backed by the Yjs workspace table.
 *
 * A Format is a single self-contained row: a name and one instruction (text in,
 * text out). No replacements, no prompt split, no per-Format model. See ADR 0013.
 *
 * @example
 * ```typescript
 * import { formats } from '$lib/state/formats.svelte';
 *
 * // Read reactively
 * const format = formats.get(id);
 * const all = formats.sorted; // alphabetical by name
 *
 * // Write
 * formats.set(format);
 * formats.delete(id);
 * ```
 */

import { fromTable } from '@epicenter/svelte';
import { nanoid } from 'nanoid/non-secure';
import { whispering } from '#platform/whispering';
import type { Format } from '$lib/workspace';

function createFormats() {
	const map = fromTable(whispering.tables.formats);

	// Memoize sorted array with $derived for referential stability.
	const sorted = $derived(
		[...map.values()].sort((a, b) => a.name.localeCompare(b.name)),
	);

	return {
		[Symbol.dispose]() {
			map[Symbol.dispose]();
		},

		/**
		 * All formats as a reactive SvelteMap.
		 *
		 * Components reading this re-render per-key when formats change.
		 */
		get all() {
			return map;
		},

		/** Get a format by ID. Returns undefined if not found. */
		get(id: string) {
			return map.get(id);
		},

		/**
		 * All formats as a sorted array (alphabetical by name). Memoized via
		 * `$derived`. Stable reference until the SvelteMap changes.
		 */
		get sorted(): Format[] {
			return sorted;
		},

		/** Create or update a format. Writes to Yjs, observer updates the SvelteMap. */
		set(format: Format) {
			whispering.tables.formats.set(format);
		},

		/** Partially update a format by ID. */
		update(id: string, partial: Partial<Omit<Format, 'id' | '_v'>>) {
			return whispering.tables.formats.update(id, partial);
		},

		/** Delete a format by ID. */
		delete(id: string) {
			whispering.tables.formats.delete(id);
		},

		/** Total number of formats. */
		get count() {
			return map.size;
		},
	};
}

export const formats = createFormats();

if (import.meta.hot) {
	import.meta.hot.dispose(() => formats[Symbol.dispose]());
}

/**
 * Generate a blank Format row: empty name and instructions, no icon. Ready to
 * pass straight to `formats.set()`.
 *
 * @example
 * ```typescript
 * const f = generateDefaultFormat();
 * formats.set(f);
 * ```
 */
export function generateDefaultFormat(): Format {
	return {
		id: nanoid(),
		name: '',
		instructions: '',
		icon: null,
	};
}
