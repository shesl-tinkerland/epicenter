/**
 * Reactive transformation run state backed by Yjs workspace tables.
 *
 * Transformation runs track execution records for transformation pipelines.
 * Each run has a status lifecycle: running → completed | failed.
 *
 * During the transition period, new runs are written to workspace tables AND
 * BlobStore (for backward compatibility). Historical runs that weren't migrated
 * are still available via BlobStore queries.
 *
 * @example
 * ```typescript
 * import { transformationRuns } from '$lib/state/transformation-runs.svelte';
 *
 * // Get runs for a specific transformation or recording
 * const runs = transformationRuns.getByTransformationId(transformationId);
 * const recordingRuns = transformationRuns.getByRecordingId(recordingId);
 * ```
 */
import { fromTable } from '@epicenter/svelte';
import { whispering } from '$lib/whispering/whispering';
import type { TransformationRun } from '$lib/workspace';

function createTransformationRuns() {
	const map = fromTable(whispering.tables.transformationRuns);

	return {
		[Symbol.dispose]() {
			map[Symbol.dispose]();
		},

		/** All transformation runs as a reactive SvelteMap. */
		get all() {
			return map;
		},

		/** Get a run by ID. */
		get(id: string) {
			return map.get(id);
		},

		/**
		 * Get all runs for a transformation, sorted newest-first.
		 *
		 * @param transformationId - FK to the parent transformation
		 */
		getByTransformationId(transformationId: string): TransformationRun[] {
			return Array.from(map.values())
				.filter((run) => run.transformationId === transformationId)
				.sort(
					(a, b) =>
						new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
				);
		},

		/**
		 * Get all runs for a recording, sorted newest-first.
		 *
		 * @param recordingId - FK to the recording
		 */
		getByRecordingId(recordingId: string): TransformationRun[] {
			return Array.from(map.values())
				.filter((run) => run.recordingId === recordingId)
				.sort(
					(a, b) =>
						new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
				);
		},

		/**
		 * Get the latest run for a recording.
		 */
		getLatestByRecordingId(recordingId: string): TransformationRun | undefined {
			return this.getByRecordingId(recordingId)[0];
		},

		/**
		 * Create or update a run.
		 */
		set(run: Omit<TransformationRun, '_v'>) {
			whispering.tables.transformationRuns.set({
				...run,
			} as TransformationRun);
		},

		/**
		 * Delete a run by ID.
		 */
		delete(id: string) {
			whispering.tables.transformationRuns.delete(id);
		},

		/** Total number of runs. */
		get count() {
			return map.size;
		},
	};
}

export const transformationRuns = createTransformationRuns();

if (import.meta.hot) {
	import.meta.hot.dispose(() => transformationRuns[Symbol.dispose]());
}
