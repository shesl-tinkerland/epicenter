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
 * Shape mirrors `local-model.svelte.ts`: factory function with `$state`
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
	type LocalModelFolderError,
} from '$lib/services/transcription/local-model-folder';
import { transcriptionReload } from '$lib/state/transcription-reload.svelte';

type ModelDownloadState =
	| { type: 'not-downloaded' }
	| { type: 'downloading'; progress: number }
	| { type: 'ready' };

function createModelDownload(model: LocalModelConfig) {
	const storage = createModelStorage(model);

	/** Disk truth: whether a valid install exists in the models folder. */
	let isInstalled = $state(false);

	/** Progress 0-100 while this handle owns a download, else null. */
	let progress = $state<number | null>(null);

	async function refresh() {
		isInstalled = (await storage.getInstalledPath()) !== null;
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
			if (progress !== null) return { type: 'downloading', progress };
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
			LocalModelFolderError
		> | null> {
			if (progress !== null) return null;
			progress = 0;

			const installedPath = await storage.getInstalledPath();
			if (installedPath) {
				isInstalled = true;
				progress = null;
				return Ok({
					entryName: modelEntryName(model),
					outcome: 'already-installed',
				});
			}

			const { error } = await storage.download({
				onProgress: (value) => {
					progress = value;
				},
			});
			if (error) {
				progress = null;
				return Err(error);
			}

			// Refresh disk truth before releasing the downloading state so the
			// computed machine lands directly on ready.
			await refresh();
			progress = null;
			// A fresh file now sits at this model's path. The selected model name
			// may be unchanged (delete + re-download under the same name), so the
			// layout's config push would not re-fire on settings alone. Bump the
			// reload signal it also reads so Rust drops and reloads the model.
			transcriptionReload.bump();
			return Ok({ entryName: modelEntryName(model), outcome: 'downloaded' });
		},

		/** Remove the catalog model from disk. Selection is cleared by callers. */
		async delete(): Promise<Result<void, LocalModelFolderError>> {
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
