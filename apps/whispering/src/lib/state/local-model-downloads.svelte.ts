/**
 * Shared download state for pre-built local transcription models, keyed by
 * engine and model id. Every surface that renders a model (recommended-model
 * hero, catalog row) reads the same handle, so a download started in one
 * place shows its progress everywhere.
 *
 * The state machine is computed, not stored: `downloading` while a download
 * owns the handle, otherwise disk truth (`isInstalled`) decides between
 * not-downloaded and ready. The selected entry name is parent-owned component
 * state, so catalog models and custom folder entries activate through the
 * same `bind:value` path.
 *
 * The models folder is user-editable truth (entries can be dropped in or
 * deleted outside the app), so `refresh()` re-checks disk; the selector calls
 * it from the same window-focus rescan that refreshes folder entries.
 *
 * Shape mirrors `recordings.svelte.ts`: factory function with `$state`
 * closure variables and a return object exposing a reactive getter plus
 * operations.
 */
import { Err, Ok, type Result } from 'wellcrafted/result';
import {
	type LocalModelConfig,
	modelEntryName,
} from '$lib/constants/local-models';
import {
	createModelStorage,
	deleteModelEntry,
	type ModelFolderError,
} from '$lib/services/transcription/local-model-folder';

type ModelDownloadState =
	| { type: 'not-downloaded' }
	| { type: 'downloading'; progress: number; cancelling: boolean }
	| { type: 'ready' };

function createModelDownload(model: LocalModelConfig) {
	const storage = createModelStorage(model);

	/** Disk truth: whether a valid install exists in the models folder. */
	let isInstalled = $state(false);

	/**
	 * The in-flight download attempt, or `null` when idle. This is the re-entry
	 * gate: `download()` sets it when a run starts and clears it only when that
	 * same run settles. `cancel()` flips `cancelling` but never clears it, so the
	 * gate stays closed until the abort actually surfaces — a cancel can never
	 * reopen the door for a second, overlapping `download_model` call on the same
	 * partial path.
	 *
	 * `id` is unique per attempt, so the Rust registry maps it to exactly one
	 * transfer for its whole lifetime. `cancelling` gates late progress callbacks
	 * (so a flushed Channel update cannot repaint after a cancel); the cancel
	 * itself, including the gap between a multi-file engine's files, is now
	 * enforced in Rust (the aborted task stops the whole staged download).
	 */
	let active = $state<{
		id: string;
		progress: number;
		cancelling: boolean;
	} | null>(null);

	/** Per-handle counter; pairs with the model key for a globally unique id. */
	let attempts = 0;

	async function refresh() {
		isInstalled = await storage.isInstalled();
	}

	void refresh();

	return {
		/**
		 * Where this model stands on this device. A getter, not a `$derived`:
		 * handles are created lazily from whichever component touches them
		 * first, and a derived created inside a component's effect context
		 * goes inert when that component is destroyed (`derived_inert`). The
		 * computation is one state read plus one null check; consumers that
		 * need caching or narrowing alias it with a component-local `$derived`.
		 */
		get state(): ModelDownloadState {
			if (active)
				return {
					type: 'downloading',
					progress: active.progress,
					cancelling: active.cancelling,
				};
			return isInstalled ? { type: 'ready' } : { type: 'not-downloaded' };
		},

		/**
		 * Re-check disk truth. The models folder can change outside the app
		 * (entries deleted, a partial download cleaned up), so callers invoke
		 * this on the same signal they use to rescan the folder, typically
		 * window focus.
		 */
		refresh,

		/**
		 * Download the model, skipping the download when a valid install
		 * already exists. Selection is owned by the caller's bound value.
		 */
		async download(): Promise<Result<
			{ outcome: 'downloaded' | 'already-installed'; entryName: string },
			ModelFolderError
		> | null> {
			if (active) return null;
			const id = `${modelDownloadKey(model)}#${++attempts}`;
			active = { id, progress: 0, cancelling: false };

			if (await storage.isInstalled()) {
				isInstalled = true;
				active = null;
				return Ok({
					entryName: modelEntryName(model),
					outcome: 'already-installed',
				});
			}

			// A cancel that arrived during the install check (before any transfer
			// started, so there is no Rust task to abort yet) stops here. Report it
			// as a no-op, like an already-in-flight call.
			if (active.cancelling) {
				active = null;
				return null;
			}

			const { error } = await storage.download({
				downloadId: id,
				// Write through `active` (the $state proxy) so the bar repaints; the
				// gate keeps `active` pointing at this attempt for the whole run.
				onProgress: (value) => {
					if (active && !active.cancelling) active.progress = value;
				},
			});
			if (error) {
				const wasCancelled = active?.cancelling ?? false;
				active = null;
				// If we asked to cancel, the abort is what produced this error: a
				// clean stop, not a failure. Report it as a no-op (like an
				// already-in-flight call) so callers raise no error toast.
				return wasCancelled ? null : Err(error);
			}

			// Refresh disk truth before releasing the gate so the computed machine
			// lands directly on ready.
			await refresh();
			active = null;
			return Ok({ entryName: modelEntryName(model), outcome: 'downloaded' });
		},

		/**
		 * Request cancellation of an in-flight download. Marks the attempt as
		 * cancelling (the UI shows "Cancelling…") and aborts its transfer in Rust;
		 * the still-running `download()` drops back to `not-downloaded` and resolves
		 * to a no-op once the abort surfaces. A no-op when nothing is downloading.
		 */
		async cancel(): Promise<void> {
			if (!active) return;
			// Leave `active` set: the owning `download()` clears it when the abort
			// surfaces. Until then the gate stays closed, so a re-download cannot
			// start a second transfer over this one.
			active.cancelling = true;
			await storage.cancel(active.id);
		},

		/** Remove the catalog model from disk. Selection is cleared by callers. */
		async delete(): Promise<Result<void, ModelFolderError>> {
			const { error } = await deleteModelEntry({
				engine: model.engine,
				name: modelEntryName(model),
			});
			if (error) return Err(error);
			isInstalled = false;
			return Ok(undefined);
		},
	};
}

/**
 * The result of a catalog `download()`: the outcome plus the folder entry
 * name to select on success, `Err` on failure, or `null` when the call was a
 * no-op (a download was already in flight).
 */
export type ModelDownloadResult = Awaited<
	ReturnType<ReturnType<typeof createModelDownload>['download']>
>;

function modelDownloadKey(model: LocalModelConfig) {
	return `${model.engine}:${model.id}`;
}

function createLocalModelDownloads() {
	const handles = new Map<string, ReturnType<typeof createModelDownload>>();

	return {
		/**
		 * The shared download handle for a catalog model, created on first
		 * use. Acquire the handle and read its `state` in separate deriveds
		 * (`$derived(localModelDownloads.get(model))`, then
		 * `$derived(handle.state)`): a derived does not depend on state it
		 * created itself, so a single derived that creates the handle and
		 * reads its state in one expression would never update.
		 */
		get(model: LocalModelConfig) {
			const key = modelDownloadKey(model);
			const existing = handles.get(key);
			if (existing) return existing;
			const handle = createModelDownload(model);
			handles.set(key, handle);
			return handle;
		},
	};
}

export const localModelDownloads = createLocalModelDownloads();
