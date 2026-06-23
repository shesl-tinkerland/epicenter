/**
 * The single source of truth for an engine's models folder, shared by every
 * surface (the first-run hero, the settings list, the catalog rows).
 *
 * It unifies the two kinds of truth a model selector needs, which are genuinely
 * different and both required:
 *
 *  - DISK STATE, at rest: which entries are in the folder, and whether each
 *    catalog model is complete. Rust owns it; this store projects it via
 *    `refresh()` (on first use, window focus, and after every mutation it
 *    performs). The scan and the completeness checks land in ONE cycle, so they
 *    can never disagree the way a component-local scan and a per-model stat did.
 *  - IN-FLIGHT TRANSFERS, in motion: downloads underway, with progress and a
 *    cancel flag. Transient, fed by the download Channel; never on disk yet. You
 *    cannot fold this into the scan: progress is a running transfer, not a file.
 *
 * Because the store is a global singleton per engine, a download started
 * anywhere updates the one store and every mounted view re-reads reactively: no
 * component-local scan to go stale, no per-model handle to drift from the folder.
 * Components are pure views.
 *
 * Selection (the active model name) is deliberately NOT here: it lives in
 * deviceConfig and is read by the transcribe dispatcher. Presence (this store)
 * and selection (deviceConfig) are different concerns; a selector joins them
 * ("is the selected name present?").
 *
 * Shape mirrors `recordings.svelte.ts`: a factory with `$state`/`SvelteMap`
 * closure variables and a return object exposing reactive getters plus
 * operations.
 */
import { SvelteMap } from 'svelte/reactivity';
import { Err, Ok, type Result } from 'wellcrafted/result';
import {
	type LocalModelConfig,
	modelEntryName,
} from '$lib/constants/local-models';
import {
	createModelStorage,
	listModelEntries,
	type ModelEntry,
	type ModelFolderError,
} from '$lib/services/transcription/local-model-folder';
import { tauri } from '#platform/tauri';

type Engine = LocalModelConfig['engine'];

export type ModelDownloadState =
	| { type: 'not-downloaded' }
	| { type: 'downloading'; progress: number; cancelling: boolean }
	| { type: 'ready' };

/**
 * The result of a catalog `download()`: the outcome plus the folder entry name
 * to select on success, `Err` on failure, or `null` when the call was a no-op
 * (a download was already in flight).
 */
export type ModelDownloadResult = Result<
	{ outcome: 'downloaded' | 'already-installed'; entryName: string },
	ModelFolderError
> | null;

function createModelFolder(catalog: readonly [LocalModelConfig, ...LocalModelConfig[]]) {
	const engine = catalog[0].engine;

	// DISK STATE. `entries` is the folder scan, `null` until the first load so the
	// UI can tell "loading" from "empty". Each entry carries its own `complete`
	// verdict, judged against the catalog by the one Rust scan, so "ready" is a
	// pure read of the scan with no second source to drift from.
	let entries = $state<ModelEntry[] | null>(null);

	// IN-FLIGHT TRANSFERS, keyed by model id. Progress re-`set`s the entry
	// (SvelteMap tracks `set`, not a nested mutation), so the bar repaints. The
	// map IS the re-entry gate: a key present means a transfer owns that model,
	// cleared only when that same run settles, so a cancel can never reopen the
	// door for a second overlapping `download_model` over the same partial path.
	// `id` is unique per attempt, so the Rust registry maps it to exactly one
	// transfer; `cancelling` gates late progress callbacks.
	const transfers = new SvelteMap<
		string,
		{ id: string; progress: number; cancelling: boolean }
	>();
	let attempts = 0;

	async function refresh() {
		if (!tauri) return;
		// One scan returns each entry already judged complete against the catalog,
		// so the listing and the "ready" verdicts are the same data.
		entries = await listModelEntries(catalog);
	}

	void refresh();

	function present(name: string): boolean {
		return (entries ?? []).some((entry) => entry.name === name);
	}

	return {
		/** The folder scan: the single disk-state source every view reads. */
		get entries() {
			return entries ?? [];
		},
		/** Whether the first scan has landed (so "empty" differs from "loading"). */
		get loaded() {
			return entries !== null;
		},
		/** Whether an entry by this exact name is in the folder right now. */
		present,
		/** Folder entries that are not catalog models (bring-your-own / linked). */
		customEntries(): ModelEntry[] {
			const names = new Set(catalog.map(modelEntryName));
			return (entries ?? []).filter((entry) => !names.has(entry.name));
		},
		/** Where a catalog model stands: a live transfer, else disk truth. */
		stateOf(model: LocalModelConfig): ModelDownloadState {
			const transfer = transfers.get(model.id);
			if (transfer)
				return {
					type: 'downloading',
					progress: transfer.progress,
					cancelling: transfer.cancelling,
				};
			const name = modelEntryName(model);
			const entry = (entries ?? []).find((e) => e.name === name);
			return entry?.complete
				? { type: 'ready' }
				: { type: 'not-downloaded' };
		},

		/**
		 * Re-check disk truth. The folder can change outside the app (entries
		 * dropped in or deleted), so views call this on window focus.
		 */
		refresh,

		/**
		 * Download a catalog model, skipping when a valid install already exists.
		 * Re-scans the folder before releasing the gate so the computed state lands
		 * directly on `ready`.
		 */
		async download(model: LocalModelConfig): Promise<ModelDownloadResult> {
			if (transfers.has(model.id)) return null;
			const id = `${engine}:${model.id}#${++attempts}`;
			transfers.set(model.id, { id, progress: 0, cancelling: false });
			const storage = createModelStorage(model);
			const name = modelEntryName(model);

			// Already installed? A fresh scan is the one truth; skip the transfer.
			await refresh();
			if ((entries ?? []).find((entry) => entry.name === name)?.complete) {
				transfers.delete(model.id);
				return Ok({ entryName: name, outcome: 'already-installed' });
			}

			// A cancel that arrived during the install check (before any transfer
			// started) stops here, reported as a no-op like an in-flight call.
			if (transfers.get(model.id)?.cancelling) {
				transfers.delete(model.id);
				return null;
			}

			const { error } = await storage.download({
				downloadId: id,
				onProgress: (progress) => {
					const transfer = transfers.get(model.id);
					if (transfer && !transfer.cancelling)
						transfers.set(model.id, { ...transfer, progress });
				},
			});
			if (error) {
				const wasCancelled = transfers.get(model.id)?.cancelling ?? false;
				transfers.delete(model.id);
				// A requested cancel is the cause of this error: a clean stop, not a
				// failure. Report it as a no-op so callers raise no error toast.
				return wasCancelled ? null : Err(error);
			}

			await refresh();
			transfers.delete(model.id);
			return Ok({ entryName: name, outcome: 'downloaded' });
		},

		/**
		 * Request cancellation of an in-flight download. Marks it cancelling (the UI
		 * shows "Cancelling…") and aborts its transfer in Rust; the still-running
		 * `download()` drops back to `not-downloaded` once the abort surfaces.
		 * Leaves the gate closed until then, so a re-download cannot start a second
		 * transfer over this one. A no-op when nothing is downloading.
		 */
		async cancel(model: LocalModelConfig): Promise<void> {
			const transfer = transfers.get(model.id);
			if (!transfer) return;
			transfers.set(model.id, { ...transfer, cancelling: true });
			await createModelStorage(model).cancel(transfer.id);
		},
	};
}

const folders = new Map<Engine, ReturnType<typeof createModelFolder>>();

/**
 * The shared `modelFolder` for an engine, created on first use from its catalog.
 * Pass the engine's catalog models (e.g. `PARAKEET_MODELS`); the same engine
 * always passes the same constant, so this is a singleton per engine.
 */
export function modelFolder(
	catalog: readonly [LocalModelConfig, ...LocalModelConfig[]],
) {
	const engine = catalog[0].engine;
	const existing = folders.get(engine);
	if (existing) return existing;
	const folder = createModelFolder(catalog);
	folders.set(engine, folder);
	return folder;
}

/** The shared folder store handle, for components that receive it as a prop. */
export type ModelFolder = ReturnType<typeof modelFolder>;
