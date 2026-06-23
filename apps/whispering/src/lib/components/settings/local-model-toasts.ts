import { toast } from '@epicenter/ui/sonner';
import type { Result } from 'wellcrafted/result';
import type { ModelFolderError } from '$lib/services/transcription/local-model-folder';
import type { ModelDownloadResult } from '$lib/state/model-folder.svelte';

/**
 * Toast the outcome of a catalog download and return the folder entry name to
 * select, or `null` when selection should stay put (the call was a no-op or
 * failed). The recommended-model hero and the catalog row present the same
 * download the same way, so both route their result through here.
 */
export function announceModelDownload(
	result: ModelDownloadResult,
): string | null {
	if (!result) return null;
	if (result.error) {
		toast.error('Failed to download model', {
			description: result.error.message,
		});
		return null;
	}

	toast.success(
		result.data.outcome === 'already-installed'
			? 'Model already downloaded and activated'
			: 'Model downloaded and activated successfully',
	);
	return result.data.entryName;
}

/**
 * Toast the outcome of removing a folder entry and report whether it
 * succeeded, so the caller can reconcile its selection. Catalog cards and
 * custom entries delete through the same primitive, so both announce it here.
 */
export function announceModelDelete(
	result: Result<unknown, ModelFolderError>,
): boolean {
	if (result.error) {
		toast.error('Failed to delete model', {
			description: result.error.message,
		});
		return false;
	}

	toast.success('Model deleted');
	return true;
}
