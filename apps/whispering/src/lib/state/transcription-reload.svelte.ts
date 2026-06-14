/**
 * A bump-only reactive signal that forces the ambient transcription-config push
 * to Rust to re-fire even when none of its named inputs changed.
 *
 * Why this exists: the config push in `(app)/+layout.svelte` keys off the
 * selected model NAME (among other settings). Deleting a local model and
 * re-downloading it under the SAME name leaves that name unchanged, and a
 * `SvelteMap.set(key, sameValue)` does not notify on an unchanged value, so the
 * effect never re-runs and Rust is never told to drop and reload the model that
 * now lives at the same path. The model-download-completion path bumps this
 * counter, the layout effect reads it, and the push fires again.
 *
 * The value itself is meaningless; only the change matters. Read `version` to
 * register the dependency; call `bump()` after a model lands on disk.
 */
function createTranscriptionReload() {
	let version = $state(0);

	return {
		/** Read this inside an effect to re-run it whenever `bump()` is called. */
		get version(): number {
			return version;
		},

		/** Signal that the resident model must be re-pushed to Rust. */
		bump() {
			version += 1;
		},
	};
}

export const transcriptionReload = createTranscriptionReload();
