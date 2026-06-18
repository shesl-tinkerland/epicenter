/**
 * Reactive Recipe state backed by the Yjs workspace table.
 *
 * A Recipe is a single self-contained row: a name and one instruction (text in,
 * text out). No replacements, no prompt split, no per-Recipe model. See ADR 0021.
 *
 * @example
 * ```typescript
 * import { recipes } from '$lib/state/recipes.svelte';
 *
 * // Read reactively
 * const recipe = recipes.get(id);
 * const all = recipes.sorted; // alphabetical by name
 *
 * // Write
 * recipes.set(recipe);
 * recipes.delete(id);
 * ```
 */

import { fromTable } from '@epicenter/svelte';
import { nanoid } from 'nanoid/non-secure';
import { whispering } from '#platform/whispering';
import type { Recipe } from '$lib/workspace';

function createRecipes() {
	const map = fromTable(whispering.tables.recipes);

	// Memoize sorted array with $derived for referential stability.
	const sorted = $derived(
		[...map.values()].sort((a, b) => a.name.localeCompare(b.name)),
	);

	return {
		[Symbol.dispose]() {
			map[Symbol.dispose]();
		},

		/**
		 * All recipes as a reactive SvelteMap.
		 *
		 * Components reading this re-render per-key when recipes change.
		 */
		get all() {
			return map;
		},

		/** Get a recipe by ID. Returns undefined if not found. */
		get(id: string) {
			return map.get(id);
		},

		/**
		 * All recipes as a sorted array (alphabetical by name). Memoized via
		 * `$derived`. Stable reference until the SvelteMap changes.
		 */
		get sorted(): Recipe[] {
			return sorted;
		},

		/** Create or update a recipe. Writes to Yjs, observer updates the SvelteMap. */
		set(recipe: Recipe) {
			whispering.tables.recipes.set(recipe);
		},

		/** Partially update a recipe by ID. */
		update(id: string, partial: Partial<Omit<Recipe, 'id' | '_v'>>) {
			return whispering.tables.recipes.update(id, partial);
		},

		/** Delete a recipe by ID. */
		delete(id: string) {
			whispering.tables.recipes.delete(id);
		},

		/** Total number of recipes. */
		get count() {
			return map.size;
		},
	};
}

export const recipes = createRecipes();

if (import.meta.hot) {
	import.meta.hot.dispose(() => recipes[Symbol.dispose]());
}

/**
 * Generate a blank Recipe row: empty name and instructions, no icon. Ready to
 * pass straight to `recipes.set()`.
 *
 * @example
 * ```typescript
 * const r = generateDefaultRecipe();
 * recipes.set(r);
 * ```
 */
export function generateDefaultRecipe(): Recipe {
	return {
		id: nanoid(),
		name: '',
		instructions: '',
		icon: null,
	};
}
