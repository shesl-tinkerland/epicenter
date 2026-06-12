/**
 * Shared download state for pre-built local transcription models, keyed by
 * model id. Every surface that renders a model (catalog row, recommended
 * model callout) reads the same handle, so a download started in one place
 * shows its progress everywhere.
 *
 * The state machine is computed, not stored: `downloading` while a download
 * owns the handle, otherwise disk truth (`installedPath`) plus the engine's
 * reactive model path setting decide between not-downloaded, ready, and
 * active. Disk is checked once when the handle is first used and kept
 * current by `download()` and `delete()`; nothing else inside the app can
 * change the install, so activation changes never need a disk re-check.
 *
 * Shape mirrors `local-model.svelte.ts`: factory function with `$state`
 * closure variables and a return object exposing a reactive getter plus
 * operations.
 */
import { toast } from '@epicenter/ui/sonner';
import type { LocalModelConfig } from '$lib/constants/local-models';
import { createPrebuiltModel } from '$lib/operations/local-models';
import { createModelStorage } from '$lib/services/transcription/local-model-storage';

export type ModelDownloadState =
	| { type: 'not-downloaded' }
	| { type: 'downloading'; progress: number }
	| { type: 'ready' }
	| { type: 'active' };

function createModelDownload(model: LocalModelConfig) {
	const storage = createModelStorage(model);
	const prebuiltModel = createPrebuiltModel(model);

	/** Disk truth: the canonical install path when a valid install exists. */
	let installedPath = $state<string | null>(null);

	/** Progress 0-100 while this handle owns a download, else null. */
	let progress = $state<number | null>(null);

	void refreshInstalledPath();

	async function refreshInstalledPath() {
		installedPath = await storage.getInstalledPath();
	}

	return {
		/**
		 * Where this model stands on this device. A getter, not a `$derived`:
		 * handles are created lazily from whichever component touches them
		 * first, and a derived created inside a component's effect context
		 * goes inert when that component is destroyed (`derived_inert`). The
		 * computation is two comparisons; consumers that need caching or
		 * narrowing alias it with a component-local `$derived`.
		 */
		get state(): ModelDownloadState {
			if (progress !== null) return { type: 'downloading', progress };
			if (!installedPath) return { type: 'not-downloaded' };
			return prebuiltModel.activeModelPath === installedPath
				? { type: 'active' }
				: { type: 'ready' };
		},

		/**
		 * Download the model (skipping the download when a valid install
		 * already exists) and activate it.
		 */
		async download() {
			if (progress !== null) return;
			progress = 0;

			const { data, error } = await prebuiltModel.downloadAndActivate({
				onProgress: (value) => {
					progress = value;
				},
			});
			if (error) {
				progress = null;
				toast.error('Failed to download model', {
					description: error.message,
				});
				return;
			}

			// Refresh disk truth before releasing the downloading state so the
			// derived machine lands directly on active.
			await refreshInstalledPath();
			progress = null;
			toast.success(
				data.outcome === 'already-installed'
					? 'Model already downloaded and activated'
					: 'Model downloaded and activated successfully',
			);
		},

		/** Point the engine's model path setting at this model. */
		async activate() {
			await prebuiltModel.activate();
			toast.success('Model activated');
		},

		/**
		 * Remove the model from disk and, when it was the engine's active
		 * model, clear the engine's model path setting.
		 */
		async delete() {
			const { error } = await prebuiltModel.delete();
			if (error) {
				toast.error('Failed to delete model', {
					description: error.message,
				});
				return;
			}
			installedPath = null;
			toast.success('Model deleted');
		},
	};
}

function createLocalModelDownloads() {
	const handles = new Map<string, ReturnType<typeof createModelDownload>>();

	return {
		/** The shared download handle for a catalog model, created on first use. */
		get(model: LocalModelConfig) {
			const existing = handles.get(model.id);
			if (existing) return existing;
			const handle = createModelDownload(model);
			handles.set(model.id, handle);
			return handle;
		},
	};
}

export const localModelDownloads = createLocalModelDownloads();
