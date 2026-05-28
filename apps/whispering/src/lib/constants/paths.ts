/**
 * Tauri path helpers for Whispering's appdata directories.
 *
 * Absolute paths under the platform appdata root:
 *   macOS:   ~/Library/Application Support/com.bradenwong.whispering/
 *   Windows: %APPDATA%/com.bradenwong.whispering/
 *   Linux:   ~/.config/com.bradenwong.whispering/
 *
 * This module must stay importable from browser builds because Svelte routes
 * and components statically import it while guarding calls with `tauri`. Keep
 * Tauri API loading lazy unless every importer moves behind a `.tauri` suffix.
 */
type TauriPathApi = typeof import('@tauri-apps/api/path');

let tauriPathApiPromise: Promise<TauriPathApi> | undefined;

function getTauriPathApi() {
	tauriPathApiPromise ??= import('@tauri-apps/api/path');
	return tauriPathApiPromise;
}

async function appDataPath(...segments: string[]) {
	const { appDataDir, join } = await getTauriPathApi();
	return join(await appDataDir(), ...segments);
}

export const PATHS = {
	/** Local transcription model directories under `models/`. */
	MODELS: {
		async WHISPER() {
			return appDataPath('models', 'whisper');
		},
		async PARAKEET() {
			return appDataPath('models', 'parakeet');
		},
		async MOONSHINE() {
			return appDataPath('models', 'moonshine');
		},
	},

	/** Filesystem storage for recording audio blobs: `recordings/{id}.{ext}`. */
	DB: {
		/** `recordings/` directory containing audio files. */
		async RECORDINGS() {
			return appDataPath('recordings');
		},
		/** Path for a newly written recording: `recordings/{id}.{extension}`. */
		async RECORDING_AUDIO(id: string, extension: string) {
			return appDataPath('recordings', `${id}.${extension}`);
		},
		/** Path to an existing recording file given its full filename. */
		async RECORDING_FILE(filename: string) {
			return appDataPath('recordings', filename);
		},
	},
};
