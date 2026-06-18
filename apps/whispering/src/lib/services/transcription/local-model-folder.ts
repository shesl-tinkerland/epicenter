/**
 * The engine's models folder, as a module. Rust owns filesystem truth for the
 * folder: enumeration, symlink resolution, stat, delete, folder creation, and
 * the full download (stage -> validate -> promote). This module is the thin JS
 * view over those commands plus the catalog-size comparison the catalog owns.
 * Settings store a folder entry name, never a path; Rust resolves and validates
 * the name against the folder at load time (`model_path_for` in
 * `src-tauri/src/transcription/model_cache.rs`).
 *
 * UI-free and settings-free. Selection is parent-owned component state:
 * settings bind to a folder entry name, and catalog/custom entries activate
 * through that same `bind:value` path.
 *
 * Layout under the appdata root, owned by Rust (`engine_models_path`):
 * - Whisper:   `models/whisper/{filename}` (a single .bin file)
 * - Parakeet:  `models/parakeet/{directoryName}/` (multiple ONNX files)
 * - Moonshine: `models/moonshine/{directoryName}/` (multiple ONNX files)
 */
import { Channel } from '@tauri-apps/api/core';
import type { Result } from 'wellcrafted/result';
import {
	type LocalModelConfig,
	modelEntryName,
} from '$lib/constants/local-models';
import {
	commands,
	type DownloadProgress,
	type ModelEntry,
	type ModelFileDownload,
	type ModelFolderError,
	type ModelImportError,
} from '$lib/tauri/commands';

export type { ModelEntry, ModelFolderError } from '$lib/tauri/commands';

type Engine = LocalModelConfig['engine'];

/**
 * List every selectable entry in the engine's models folder. Rust applies the
 * per-engine shape filter (Whisper model files; directories for the others),
 * resolves links, and sorts. Returns an empty list on any error (never
 * rejects), so the selector always has something to render.
 */
export async function listModelEntries(engine: Engine): Promise<ModelEntry[]> {
	const { data } = await commands.listModelEntries(engine);
	return data ?? [];
}

/**
 * Remove one entry from the engine's models folder. A symlinked entry removes
 * only the link, never its target; a real entry is removed outright. Succeeds
 * when the entry is already gone.
 */
export async function deleteModelEntry({
	engine,
	name,
}: {
	engine: Engine;
	name: string;
}): Promise<Result<null, ModelFolderError>> {
	return commands.deleteModelEntry(engine, name);
}

/**
 * Link a model already on disk into the engine's folder as a symlink entry,
 * without copying bytes. `sourcePath` is an absolute path from the native
 * picker (a file for Whisper, a directory for Parakeet/Moonshine), and
 * `entryName` is the folder entry name to create (and to store as the active
 * selection). Rust validates the engine shape and creates the link. Deletion
 * later removes only the link, never its target.
 */
export async function linkModelEntry({
	engine,
	entryName,
	sourcePath,
}: {
	engine: Engine;
	entryName: string;
	sourcePath: string;
}): Promise<Result<null, ModelImportError>> {
	return commands.linkLocalModel(engine, entryName, sourcePath);
}

/** Create the engine's models folder if needed and open it in the OS file manager. */
export async function revealModelsFolder(
	engine: Engine,
): Promise<Result<null, ModelFolderError>> {
	return commands.revealModelsFolder(engine);
}

/** The files to stream for a catalog download, in the shape `download_model` takes. */
function modelDownloadFiles(model: LocalModelConfig): ModelFileDownload[] {
	switch (model.engine) {
		case 'whispercpp':
			return [
				{
					url: model.file.url,
					filename: model.file.filename,
					sizeBytes: model.sizeBytes,
				},
			];
		case 'parakeet':
		case 'moonshine':
			return model.files.map((file) => ({
				url: file.url,
				filename: file.filename,
				sizeBytes: file.sizeBytes,
			}));
	}
}

/**
 * The files to stat and their expected sizes for the install check. Whisper's
 * entry is itself the file (empty `filenames`, so Rust stats the entry);
 * directory engines check each contained file.
 */
function modelSizeChecks(model: LocalModelConfig): {
	filenames: string[];
	expected: number[];
} {
	switch (model.engine) {
		case 'whispercpp':
			return { filenames: [], expected: [model.sizeBytes] };
		case 'parakeet':
		case 'moonshine':
			return {
				filenames: model.files.map((file) => file.filename),
				expected: model.files.map((file) => file.sizeBytes),
			};
	}
}

/**
 * Per-model handle over a catalog model's install in the folder. Stateless;
 * safe to recreate freely.
 */
export function createModelStorage(model: LocalModelConfig) {
	return {
		/**
		 * Whether a valid install exists in the folder. JS passes the catalog's
		 * expected sizes; Rust resolves the entry through any link, stats each file,
		 * and returns the completeness verdict (the 90% rule lives in Rust next to
		 * the stat). One path serves downloaded, linked, and hand-dropped installs,
		 * so a linked-but-broken model reads as not installed. Never rejects; any
		 * error reads as not installed.
		 */
		async isInstalled(): Promise<boolean> {
			const { filenames, expected } = modelSizeChecks(model);
			const { data: statuses } = await commands.resolveModelFiles(
				model.engine,
				modelEntryName(model),
				filenames,
				expected,
			);
			if (!statuses || statuses.length !== expected.length) return false;
			return statuses.every((status) => status.complete);
		},

		/**
		 * Download the model to its canonical path. Rust stages, integrity-checks
		 * each file, and promotes with one rename; a cancel or error cleans up the
		 * staging. `onProgress` receives overall progress as 0-100, aggregated
		 * across files by Rust. Does not check for an existing install; callers
		 * decide whether to skip.
		 */
		async download({
			downloadId,
			onProgress,
		}: {
			/** Unique per attempt; `cancel(downloadId)` aborts this run. */
			downloadId: string;
			onProgress: (progress: number) => void;
		}): Promise<Result<null, ModelFolderError>> {
			const onProgressChannel = new Channel<DownloadProgress>();
			onProgressChannel.onmessage = ({ bytesReceived, totalBytes }) => {
				// f64 fields arrive as `number | null` (specta guards non-finite
				// floats). The grand total is always positive, but guard anyway.
				const received = bytesReceived ?? 0;
				const total = totalBytes && totalBytes > 0 ? totalBytes : 0;
				if (total <= 0) return;
				onProgress(Math.min(100, Math.round((received / total) * 100)));
			};
			return commands.downloadModel(
				model.engine,
				modelEntryName(model),
				modelDownloadFiles(model),
				downloadId,
				onProgressChannel,
			);
		},

		/**
		 * Abort the in-flight download attempt registered under `downloadId`: the
		 * matching `download()` call's transfer aborts in Rust and errors out, and
		 * Rust removes the staging. A no-op when nothing is downloading under that id.
		 */
		async cancel(downloadId: string): Promise<void> {
			await commands.cancelDownload(downloadId);
		},
	};
}
