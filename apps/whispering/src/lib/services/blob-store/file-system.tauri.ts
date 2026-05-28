import { convertFileSrc } from '@tauri-apps/api/core';
import {
	mkdir,
	readDir,
	readFile,
	writeFile as tauriWriteFile,
} from '@tauri-apps/plugin-fs';
import mime from 'mime';
import { tryAsync } from 'wellcrafted/result';
import { PATHS } from '$lib/constants/paths';
import { commands } from '$lib/tauri/commands';
import { BlobError, type BlobStore } from './types';

/**
 * File system-based blob store implementation for desktop.
 * Stores audio files on the Tauri filesystem.
 *
 * Directory structure:
 * - recordings/
 *   - {id}.{ext} (audio file: .wav, .opus, .mp3, etc.)
 */
export function createFileSystemBlobStore() {
	return {
		async save(key, blob) {
			return tryAsync({
				try: async () => {
					const recordingsPath = await PATHS.DB.RECORDINGS();
					await mkdir(recordingsPath, { recursive: true });

					const extension = mime.getExtension(blob.type) ?? 'bin';
					const audioPath = await PATHS.DB.RECORDING_AUDIO(key, extension);
					const arrayBuffer = await blob.arrayBuffer();
					await tauriWriteFile(audioPath, new Uint8Array(arrayBuffer));
				},
				catch: (error) => BlobError.WriteFailed({ cause: error }),
			});
		},

		async delete(idOrIds) {
			const ids = Array.isArray(idOrIds) ? idOrIds : [idOrIds];
			return tryAsync({
				try: async () => {
					const { error } = await commands.deleteRecordingArtifacts(ids);
					if (error !== null) throw error;
				},
				catch: (error) => BlobError.WriteFailed({ cause: error }),
			});
		},

		async getBlob(key: string) {
			return tryAsync({
				try: async () => {
					const recordingsPath = await PATHS.DB.RECORDINGS();
					const audioFilename = await findAudioFile(recordingsPath, key);

					if (!audioFilename) {
						throw new Error(`Audio file not found for key ${key}`);
					}

					const audioPath = await PATHS.DB.RECORDING_FILE(audioFilename);

					return await readFileAsBlob(audioPath);
				},
				catch: (error) => BlobError.ReadFailed({ cause: error }),
			});
		},

		async ensurePlaybackUrl(key: string) {
			return tryAsync({
				try: async () => {
					const recordingsPath = await PATHS.DB.RECORDINGS();
					const audioFilename = await findAudioFile(recordingsPath, key);

					if (!audioFilename) {
						throw new Error(`Audio file not found for key ${key}`);
					}

					const audioPath = await PATHS.DB.RECORDING_FILE(audioFilename);
					const assetUrl = convertFileSrc(audioPath);

					// Return the URL as-is from convertFileSrc()
					// The Tauri backend handles URL decoding automatically
					return assetUrl;
				},
				catch: (error) => BlobError.ReadFailed({ cause: error }),
			});
		},

		revokeUrl(_key: string) {
			// No-op on desktop, URLs are asset:// protocol managed by Tauri
		},

		async clear() {
			return tryAsync({
				try: async () => {
					const { error } = await commands.clearRecordingArtifacts();
					if (error !== null) throw error;
				},
				catch: (error) => BlobError.WriteFailed({ cause: error }),
			});
		},
	} satisfies BlobStore;
}

function isAudioFilename(filename: string) {
	return !filename.endsWith('.md');
}

/**
 * Helper function to find audio file by ID.
 * Reads directory once and finds the matching file by ID prefix.
 * This is much faster than checking every possible extension.
 */
async function findAudioFile(dir: string, id: string): Promise<string | null> {
	const files = await readDir(dir);
	const audioFile = files.find(
		(f) => f.name.startsWith(`${id}.`) && isAudioFilename(f.name),
	);
	return audioFile?.name ?? null;
}

async function readFileAsBlob(path: string): Promise<Blob> {
	// Cast is safe: Tauri's readFile always returns ArrayBuffer-backed Uint8Array.
	const bytes = (await readFile(path)) as Uint8Array<ArrayBuffer>;
	const mimeType = mime.getType(path) ?? 'application/octet-stream';
	return new Blob([bytes], { type: mimeType });
}
