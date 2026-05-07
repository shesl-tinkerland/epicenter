/**
 * Reactive transformation state backed by Yjs workspace tables.
 *
 * Replaces TanStack Query + BlobStore for transformation CRUD. The workspace
 * model stores transformations as metadata rows (title, description, timestamps)
 * without embedded steps—steps live in a separate `transformationSteps` table.
 *
 * @example
 * ```typescript
 * import { transformations } from '$lib/state/transformations.svelte';
 *
 * // Read reactively
 * const transformation = transformations.byId(id);
 * const all = transformations.sorted; // alphabetical by title
 *
 * // Write
 * transformations.set(transformation);
 * transformations.delete(id);
 * ```
 */

import { fromTable } from '@epicenter/svelte';
import { nanoid } from 'nanoid/non-secure';
import { whispering } from '$lib/whispering/client';
import type { Transformation, TransformationStep } from '$lib/workspace';
import { transformationSteps } from './transformation-steps.svelte';

function createTransformations() {
	const view = fromTable(whispering.tables.transformations);

	// Memoize sorted array with $derived for referential stability.
	const sorted = $derived(
		view.all.toSorted((a, b) => a.title.localeCompare(b.title)),
	);

	return {
		/**
		 * All transformations as a reactive readonly array.
		 */
		get all() {
			return view.all;
		},

		/**
		 * Get a transformation by ID. Returns undefined if not found.
		 */
		byId(id: string) {
			return view.byId(id);
		},

		/**
		 * All transformations as a sorted array (alphabetical by title).
		 * Memoized via `$derived`, stable until the table changes.
		 */
		get sorted(): Transformation[] {
			return sorted;
		},

		/**
		 * Create or update a transformation. Writes to Yjs → observer updates SvelteMap.
		 */
		set(transformation: Transformation) {
			whispering.tables.transformations.set(transformation);
		},

		/**
		 * Partially update a transformation by ID.
		 */
		update(id: string, partial: Partial<Omit<Transformation, 'id' | '_v'>>) {
			return whispering.tables.transformations.update(id, partial);
		},

		/**
		 * Delete a transformation by ID.
		 */
		delete(id: string) {
			whispering.tables.transformations.delete(id);
		},

		/** Total number of transformations. */
		get count() {
			return view.all.length;
		},
	};
}

export const transformations = createTransformations();

/**
 * Generate a default transformation with sensible defaults.
 *
 * Includes `_v` so the returned value is a full `Transformation` ready
 * for workspace writes without any Omit gymnastics.
 *
 * @example
 * ```typescript
 * const t = generateDefaultTransformation();
 * transformations.set(t);
 * ```
 */
export function generateDefaultTransformation(): Transformation {
	const now = new Date().toISOString();
	return {
		id: nanoid(),
		title: '',
		description: '',
		createdAt: now,
		updatedAt: now,
		_v: 1,
	};
}

/**
 * Atomically save a transformation and its steps in a single workspace batch.
 *
 * Works for both create and update:
 * - Sets `updatedAt` to now (harmless on create since it was already "now").
 * - Deletes existing steps first (no-op on create since none exist yet),
 *   then re-inserts with correct ordering.
 *
 * Callers should pass `$state.snapshot()` values—this function takes plain data.
 *
 * @example
 * ```typescript
 * const snap = $state.snapshot(transformation);
 * const stepsSnap = $state.snapshot(steps);
 * saveTransformationWithSteps(snap, stepsSnap);
 * ```
 */
export function saveTransformationWithSteps(
	transformation: Transformation,
	steps: TransformationStep[],
) {
	whispering.batch(() => {
		transformations.set({
			...transformation,
			updatedAt: new Date().toISOString(),
		});
		transformationSteps.deleteByTransformationId(transformation.id);
		for (const [order, step] of steps.entries()) {
			transformationSteps.set({
				...step,
				transformationId: transformation.id,
				order,
			});
		}
	});
}
