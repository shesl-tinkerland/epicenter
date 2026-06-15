/**
 * The engine's models folder, as a module. The folder is the single source
 * of truth for local transcription models: catalog downloads land in it,
 * and users add their own models by dropping (or symlinking) them into it.
 * Settings store a folder entry name, never a path; Rust resolves and
 * validates the name against the folder at load time (`model_path_for` in
 * `src-tauri/src/transcription/model_manager.rs`). This module owns the
 * JS view of the folder: listing entries, streaming catalog downloads into
 * it, and deleting entries, never anything outside the folder.
 *
 * UI-free and settings-free. Selection is parent-owned component state:
 * settings bind to a folder entry name, and catalog/custom entries activate
 * through that same `bind:value` path.
 *
 * Layout under the appdata root (see `$lib/services/fs-paths`):
 * - Whisper:   `models/whisper/{filename}` (a single .bin file)
 * - Parakeet:  `models/parakeet/{directoryName}/` (multiple ONNX files)
 * - Moonshine: `models/moonshine/{directoryName}/` (multiple ONNX files)
 */
import { Channel } from '@tauri-apps/api/core';
import { join } from '@tauri-apps/api/path';
import {
	exists,
	mkdir,
	readDir,
	remove,
	rename,
	stat,
} from '@tauri-apps/plugin-fs';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { Err, Ok, type Result, tryAsync } from 'wellcrafted/result';
import {
	type LocalModelConfig,
	modelEntryName,
} from '$lib/constants/local-models';
import { PATHS } from '$lib/services/fs-paths';
import { isModelFileSizeValid } from '$lib/services/transcription/model-file';
import { commands, type DownloadProgress } from '$lib/tauri/commands';

export const LocalModelFolderError = defineErrors({
	DownloadIncomplete: ({
		downloadedMb,
		expectedMb,
	}: {
		downloadedMb: number;
		expectedMb: number;
	}) => ({
		message: `Download incomplete: received ${downloadedMb}MB but expected ${expectedMb}MB. Please check your network connection and try again.`,
		downloadedMb,
		expectedMb,
	}),
	DownloadFailed: ({ cause }: { cause: unknown }) => ({
		message: extractErrorMessage(cause),
		cause,
	}),
	DeleteFailed: ({ cause }: { cause: unknown }) => ({
		message: extractErrorMessage(cause),
		cause,
	}),
});
export type LocalModelFolderError = InferErrors<typeof LocalModelFolderError>;

type Engine = LocalModelConfig['engine'];

/** Extensions a Whisper model file may carry (catalog or user-provided). */
const WHISPER_MODEL_EXTENSIONS = ['.bin', '.gguf', '.ggml'];

/**
 * Resolve a folder entry name to the absolute path Rust loads. Pure path
 * math; does not touch disk. The JS mirror of Rust's `model_path_for`,
 * for JS-side checks that need to stat a known catalog file (e.g. the
 * Whisper truncation check).
 */
export async function resolveModelPath(
	engine: Engine,
	name: string,
): Promise<string> {
	return join(await PATHS.MODELS[engine](), name);
}

export type LocalModelEntry = {
	/** File or directory name inside the engine's models folder. */
	name: string;
	/**
	 * Symlinked entries are listed by link name alone. The webview's fs scope
	 * canonicalizes link targets, so a link pointing outside appdata cannot
	 * be stat'd or read from here; Rust resolves links natively when loading.
	 */
	isSymlink: boolean;
};

/**
 * List every selectable entry in the engine's models folder: model files
 * (.bin, .gguf, .ggml) for Whisper, directories for Parakeet and Moonshine,
 * plus symlinks to either. Hidden entries are skipped. Returns an empty list
 * when the folder does not exist yet. Never rejects.
 */
export async function listModelEntries(
	engine: Engine,
): Promise<LocalModelEntry[]> {
	const { data: entries } = await tryAsync({
		try: async () => {
			const modelsDir = await PATHS.MODELS[engine]();
			if (!(await exists(modelsDir))) return [];
			const dirEntries = await readDir(modelsDir);
			return dirEntries
				.filter((entry) => {
					if (entry.name.startsWith('.')) return false;
					// In-flight or leftover download staging (a `.partial` file or
					// directory) is never a selectable model.
					if (entry.name.endsWith('.partial')) return false;
					if (engine === 'whispercpp') {
						const hasModelExtension = WHISPER_MODEL_EXTENSIONS.some((ext) =>
							entry.name.endsWith(ext),
						);
						return hasModelExtension && (entry.isFile || entry.isSymlink);
					}
					return entry.isDirectory || entry.isSymlink;
				})
				.map((entry) => ({ name: entry.name, isSymlink: entry.isSymlink }));
		},
		catch: () => Ok([]),
	});
	return (entries ?? []).toSorted((a, b) => a.name.localeCompare(b.name));
}

/**
 * Remove one entry from the engine's models folder. The target is always
 * `join(modelsDir, name)` for a name that `readDir` reported, so this can
 * never delete anything outside the folder, and a symlinked entry removes
 * only the link, never its target. Succeeds when the entry is already gone.
 */
export async function deleteModelEntry({
	engine,
	name,
}: {
	engine: Engine;
	name: string;
}): Promise<Result<void, LocalModelFolderError>> {
	const { data: found, error: readError } = await tryAsync({
		try: async () => {
			const modelsDir = await PATHS.MODELS[engine]();
			if (!(await exists(modelsDir))) return null;
			const entry = (await readDir(modelsDir)).find((e) => e.name === name);
			if (!entry) return null;
			return { entry, path: await join(modelsDir, name) };
		},
		catch: (error) => LocalModelFolderError.DeleteFailed({ cause: error }),
	});
	if (readError) return Err(readError);
	if (!found) return Ok(undefined);

	return tryAsync({
		try: async () => {
			await remove(found.path, { recursive: found.entry.isDirectory });
		},
		catch: (error) =>
			LocalModelFolderError.DeleteFailed({
				// A link pointing outside appdata is scope-rejected even for
				// removal; the user manages that link themselves.
				cause: found.entry.isSymlink
					? 'Whispering cannot remove this link. Delete it from the models folder yourself.'
					: error,
			}),
	});
}

/** Remove a leftover partial file or staging directory, ignoring any error. */
async function removeQuietly(
	path: string,
	options?: { recursive?: boolean },
): Promise<void> {
	await tryAsync({
		try: () => remove(path, options),
		catch: () => Ok(undefined),
	});
}

/**
 * Stream one URL to `filePath` and size-check the result. `filePath` is always
 * a caller-owned staging path, never the canonical install path, so a crash
 * mid-download can only leave a truncated file in staging — which the caller
 * discards. The transfer runs under `downloadId` so `cancel_download` can abort
 * it mid-flight. Removes the file on any failure (a real error or a cancel,
 * which surfaces as an aborted transfer). Reports whole-file progress as 0-100.
 */
async function streamModelFile({
	downloadId,
	url,
	sizeBytes,
	filePath,
	onProgress,
}: {
	/** Cancellation key; `cancelDownload(downloadId)` aborts this transfer. */
	downloadId: string;
	url: string;
	/** Catalog size, used for progress when the response omits content-length. */
	sizeBytes: number;
	/** Staging path to stream into; the caller promotes it once it validates. */
	filePath: string;
	onProgress: (progress: number) => void;
}): Promise<Result<void, LocalModelFolderError>> {
	const onProgressChannel = new Channel<DownloadProgress>();
	onProgressChannel.onmessage = ({ bytesReceived, totalBytes }) => {
		// f64 fields arrive as `number | null` (specta guards non-finite floats);
		// missing content-length is 0, so fall back to the catalog size.
		const received = bytesReceived ?? 0;
		const expected = totalBytes && totalBytes > 0 ? totalBytes : sizeBytes;
		// Clamp: a file larger than its catalog size (or a content-length-less
		// response) can push the ratio past 100, which the progress bar should
		// never show.
		onProgress(Math.min(100, Math.round((received / expected) * 100)));
	};

	const { error: downloadError } = await commands.downloadFile(
		downloadId,
		url,
		filePath,
		onProgressChannel,
	);
	if (downloadError) {
		// Covers both a real failure and a cancel (an aborted transfer surfaces
		// as an error). Either way the file is incomplete, so drop it; the state
		// layer decides whether the error reaches the user.
		await removeQuietly(filePath);
		return LocalModelFolderError.DownloadFailed({ cause: downloadError });
	}

	// download_file streams to EOF without validating content-length, so a
	// truncated-but-cleanly-closed response still resolves. This size re-check
	// against the catalog size is the integrity gate before the caller promotes.
	const { data: stats, error: statError } = await tryAsync({
		try: () => stat(filePath),
		catch: (error) => LocalModelFolderError.DownloadFailed({ cause: error }),
	});
	if (statError) {
		await removeQuietly(filePath);
		return Err(statError);
	}
	if (!isModelFileSizeValid(stats.size, sizeBytes)) {
		await removeQuietly(filePath);
		return LocalModelFolderError.DownloadIncomplete({
			downloadedMb: Math.round(stats.size / 1_000_000),
			expectedMb: Math.round(sizeBytes / 1_000_000),
		});
	}
	return Ok(undefined);
}

/**
 * Promote validated staging to its canonical path with a single rename,
 * replacing any stale entry already there (only reached when no valid install
 * exists). Clears staging if the rename fails. `recursive` matches the staging
 * kind: a bare file for Whisper, a directory for multi-file engines.
 */
async function promoteStaging(
	staging: string,
	destination: string,
	options?: { recursive?: boolean },
): Promise<Result<void, LocalModelFolderError>> {
	const { error } = await tryAsync({
		try: async () => {
			if (await exists(destination)) await remove(destination, options);
			await rename(staging, destination);
		},
		catch: (error) => LocalModelFolderError.DownloadFailed({ cause: error }),
	});
	if (error) {
		await removeQuietly(staging, options);
		return Err(error);
	}
	return Ok(undefined);
}

/**
 * Per-model handle over a catalog model's install in the folder. Stateless;
 * safe to recreate freely.
 */
export function createModelStorage(model: LocalModelConfig) {
	async function getPath(): Promise<string> {
		const dir = await PATHS.MODELS[model.engine]();
		switch (model.engine) {
			case 'whispercpp':
				return join(dir, model.file.filename);
			case 'parakeet':
			case 'moonshine':
				return join(dir, model.directoryName);
		}
	}

	async function hasListedSymlinkEntry(): Promise<boolean> {
		const entries = await listModelEntries(model.engine);
		return entries.some(
			(entry) => entry.name === modelEntryName(model) && entry.isSymlink,
		);
	}

	return {
		/**
		 * Whether a valid install exists in the folder. Two paths to true:
		 *
		 * 1. A listed symlink entry with this model's name *is* the install.
		 *    The user manages the link, and its target may live outside appdata
		 *    where the webview fs scope cannot stat it, so it is trusted as-is —
		 *    never size-validated.
		 * 2. Otherwise a real install: every expected file present at a plausible
		 *    size (at least 90% of the catalog size), so an interrupted download
		 *    reads as not installed.
		 *
		 * Never rejects; any filesystem or path error reads as not installed.
		 */
		async isInstalled(): Promise<boolean> {
			if (await hasListedSymlinkEntry()) return true;

			// The symlink case is handled above, so any error here just means the
			// real install is absent or unreadable: not installed.
			const { data: valid } = await tryAsync({
				try: async (): Promise<boolean> => {
					const path = await getPath();
					if (!(await exists(path))) return false;
					switch (model.engine) {
						case 'whispercpp': {
							const stats = await stat(path);
							return isModelFileSizeValid(stats.size, model.sizeBytes);
						}
						case 'parakeet':
						case 'moonshine': {
							const dirStats = await stat(path);
							if (!dirStats.isDirectory) return false;
							for (const file of model.files) {
								const filePath = await join(path, file.filename);
								if (!(await exists(filePath))) return false;
								const fileStats = await stat(filePath);
								if (!isModelFileSizeValid(fileStats.size, file.sizeBytes)) {
									return false;
								}
							}
							return true;
						}
					}
				},
				catch: () => Ok(false),
			});
			return valid ?? false;
		},

		/**
		 * Download the model to its canonical path. `onProgress` receives
		 * overall progress as 0-100, aggregated across files for multi-file
		 * models. Does not check for an existing install; callers decide
		 * whether to skip.
		 *
		 * Cancellation has three seams: a pre-check before any transfer starts
		 * (so a cancel that lands in the caller's install-check window is honored
		 * for every engine), `cancel()` aborting the in-flight transfer in Rust
		 * (the active file's download then errors out), and the `isCancelled`
		 * predicate between files so a cancel in the gap between a multi-file
		 * engine's downloads still stops the run. Either way the error reads as a
		 * plain failure here; the caller that requested the cancel is what knows
		 * to treat it as a clean stop. Defaults to never-cancelled for callers
		 * that do not wire it.
		 *
		 * Every engine stages under a sibling `.partial` (a bare file for Whisper,
		 * a directory for multi-file engines) and promotes it with a single
		 * rename, so an interrupted run never leaves a partial install at the
		 * canonical path for the selector to list.
		 */
		async download({
			downloadId,
			onProgress,
			isCancelled = () => false,
		}: {
			/** Unique per attempt; `cancel(downloadId)` aborts this run's transfer. */
			downloadId: string;
			onProgress: (progress: number) => void;
			isCancelled?: () => boolean;
		}): Promise<Result<void, LocalModelFolderError>> {
			const { data: destination, error: prepareError } = await tryAsync({
				try: async () => {
					await mkdir(await PATHS.MODELS[model.engine](), { recursive: true });
					return getPath();
				},
				catch: (error) =>
					LocalModelFolderError.DownloadFailed({ cause: error }),
			});
			if (prepareError) return Err(prepareError);

			// A cancel that arrived before any transfer started (e.g. while the
			// caller checked for an existing install) stops here, uniformly for
			// every engine.
			if (isCancelled()) {
				return LocalModelFolderError.DownloadFailed({
					cause: 'Download cancelled',
				});
			}

			const staging = `${destination}.partial`;

			switch (model.engine) {
				case 'whispercpp': {
					const { error } = await streamModelFile({
						downloadId,
						url: model.file.url,
						sizeBytes: model.sizeBytes,
						filePath: staging,
						onProgress,
					});
					if (error) return Err(error);
					return promoteStaging(staging, destination);
				}
				case 'parakeet':
				case 'moonshine': {
					const { error: stagingError } = await tryAsync({
						try: async () => {
							// Clear any leftover staging from an interrupted run, then
							// start clean.
							await removeQuietly(staging, { recursive: true });
							await mkdir(staging, { recursive: true });
						},
						catch: (error) =>
							LocalModelFolderError.DownloadFailed({ cause: error }),
					});
					if (stagingError) return Err(stagingError);

					const totalBytes = model.sizeBytes;
					let completedBytes = 0;
					for (const file of model.files) {
						// A cancel that arrived between files (no transfer in flight
						// for Rust to abort) still stops the run here, before the
						// next file would otherwise complete the install. The state
						// layer maps this to a no-op (it knows it cancelled).
						if (isCancelled()) {
							await removeQuietly(staging, { recursive: true });
							return LocalModelFolderError.DownloadFailed({
								cause: 'Download cancelled',
							});
						}
						const { data: filePath, error: joinError } = await tryAsync({
							try: () => join(staging, file.filename),
							catch: (error) =>
								LocalModelFolderError.DownloadFailed({ cause: error }),
						});
						if (joinError) {
							await removeQuietly(staging, { recursive: true });
							return Err(joinError);
						}
						const { error } = await streamModelFile({
							downloadId,
							url: file.url,
							sizeBytes: file.sizeBytes,
							filePath,
							onProgress: (fileProgress) => {
								onProgress(
									Math.round(
										((completedBytes + (file.sizeBytes * fileProgress) / 100) /
											totalBytes) *
											100,
									),
								);
							},
						});
						if (error) {
							await removeQuietly(staging, { recursive: true });
							return Err(error);
						}
						completedBytes += file.sizeBytes;
					}

					return promoteStaging(staging, destination, { recursive: true });
				}
			}
		},

		/**
		 * Abort the in-flight download attempt registered under `downloadId`:
		 * the matching `download()` call's current file aborts in Rust and errors
		 * out, and `download` then removes the partial. A no-op when nothing is
		 * downloading under that id.
		 */
		async cancel(downloadId: string): Promise<void> {
			await commands.cancelDownload(downloadId);
		},
	};
}
