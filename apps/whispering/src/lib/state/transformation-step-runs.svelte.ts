/**
 * Reactive transformation step-run state backed by Yjs workspace tables.
 *
 * Step runs are the per-step execution records within a transformation run.
 * Each step run links to its parent run via `transformationRunId` and carries
 * an `order` for sequencing the steps within that run.
 *
 * @example
 * ```typescript
 * import { transformationStepRuns } from '$lib/state/transformation-step-runs.svelte';
 *
 * // Get the ordered step runs for a transformation run
 * const steps = transformationStepRuns.getByTransformationRunId(runId);
 * ```
 */
import { fromTable } from '@epicenter/svelte';
import { whispering } from '$lib/whispering/whispering';
import type { TransformationStepRun } from '$lib/workspace';

function createTransformationStepRuns() {
	const map = fromTable(whispering.tables.transformationStepRuns);

	return {
		[Symbol.dispose]() {
			map[Symbol.dispose]();
		},

		/** All step runs as a reactive SvelteMap. */
		get all() {
			return map;
		},

		/** Get a step run by ID. */
		get(id: string) {
			return map.get(id);
		},

		/**
		 * Get all step runs for a transformation run, ordered by step `order`.
		 *
		 * @param transformationRunId - FK to the parent transformation run
		 */
		getByTransformationRunId(
			transformationRunId: string,
		): TransformationStepRun[] {
			return Array.from(map.values())
				.filter(
					(stepRun) => stepRun.transformationRunId === transformationRunId,
				)
				.sort((a, b) => a.order - b.order);
		},

		/** Create or update a step run. */
		set(stepRun: TransformationStepRun) {
			whispering.tables.transformationStepRuns.set(stepRun);
		},

		/** Total number of step runs. */
		get count() {
			return map.size;
		},
	};
}

export const transformationStepRuns = createTransformationStepRuns();

if (import.meta.hot) {
	import.meta.hot.dispose(() => transformationStepRuns[Symbol.dispose]());
}
