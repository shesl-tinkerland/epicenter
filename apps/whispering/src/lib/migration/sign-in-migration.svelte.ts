/**
 * First-sign-in migration: move this device's signed-out PLAINTEXT local doc
 * into the signed-in encrypted owner doc.
 *
 * Flag-free: the local data itself is the state. On each signed-in boot we probe
 * the local doc's recording count; > 0 opens the dialog, which nags again next
 * boot until the user picks Add or Delete. "Add" copies local rows into the owner
 * doc (idempotent by id) then deletes the plaintext local copy, so the deletion
 * both removes the lingering plaintext duplicate AND is why no "migrated" flag is
 * needed (count drops to 0).
 *
 * The local source is opened only momentarily (probe, then each action re-opens),
 * so nothing is held across the dialog's lifetime and a dismissed dialog leaks
 * nothing.
 */

import { toastOnError } from '@epicenter/ui/sonner';
import { attachIndexedDb } from '@epicenter/workspace';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { tryAsync } from 'wellcrafted/result';
import { auth } from '#platform/auth';
import { whispering } from '#platform/whispering';
import { createWhispering } from '$lib/workspace';

const SignInMigrationError = defineErrors({
	AddFailed: ({ cause }: { cause: unknown }) => ({
		message: `Could not add your recordings to this account: ${extractErrorMessage(cause)}`,
		cause,
	}),
	DeleteFailed: ({ cause }: { cause: unknown }) => ({
		message: `Could not remove the local recordings: ${extractErrorMessage(cause)}`,
		cause,
	}),
});
type SignInMigrationError = InferErrors<typeof SignInMigrationError>;

/**
 * Open a throwaway handle to the signed-out plaintext local doc (the migration
 * source). `createWhispering()` with no keyring opens the same
 * `epicenter-whispering` IndexedDB the signed-out app uses; the owner doc's
 * storage is partitioned + encrypted, so this never collides with the active
 * synced doc. `dispose()` tears down the connection without deleting data
 * (`clearLocal` does the deletion).
 */
function openLocalSource() {
	const workspace = createWhispering();
	const idb = attachIndexedDb(workspace.ydoc);
	return {
		tables: workspace.tables,
		whenLoaded: idb.whenLoaded,
		clearLocal: idb.clearLocal,
		dispose: () => workspace.ydoc.destroy(),
	};
}

type LocalSource = ReturnType<typeof openLocalSource>;

/** Upsert every valid row from one table into another; idempotent by id. */
function copyTable<R extends { id: string }>(
	from: { getAllValid(): R[] },
	to: { set(row: R): void },
): void {
	for (const row of from.getAllValid()) to.set(row);
}

/**
 * Copy the whole local doc into the owner doc in one transaction (one observer
 * fire, one relay batch), then delete the plaintext local copy. The copy is
 * synchronous, so it either fully lands before `clearLocal` or throws before it;
 * a throw leaves the local copy intact, so the next boot re-prompts and re-runs
 * idempotently.
 */
async function addLocalToOwner(source: LocalSource): Promise<void> {
	await whispering.whenReady;
	whispering.ydoc.transact(() => {
		copyTable(source.tables.recordings, whispering.tables.recordings);
		copyTable(source.tables.transformations, whispering.tables.transformations);
		copyTable(
			source.tables.transformationSteps,
			whispering.tables.transformationSteps,
		);
		copyTable(
			source.tables.transformationRuns,
			whispering.tables.transformationRuns,
		);
		copyTable(
			source.tables.transformationStepRuns,
			whispering.tables.transformationStepRuns,
		);
	});
	await source.clearLocal();
}

function createSignInMigration() {
	let open = $state(false);
	let recordingCount = $state(0);
	let phase = $state<'idle' | 'adding' | 'deleting'>('idle');
	let hasChecked = false;

	return {
		get open() {
			return open;
		},
		set open(value: boolean) {
			open = value;
		},
		get recordingCount() {
			return recordingCount;
		},
		get phase() {
			return phase;
		},
		get isBusy() {
			return phase !== 'idle';
		},

		/**
		 * Probe once per boot. When signed in, open the local doc, count its
		 * recordings, and dispose it. count > 0 opens the dialog. No flag: the count
		 * is the state, so the prompt returns next signed-in boot until resolved.
		 */
		async check(): Promise<void> {
			if (hasChecked) return;
			hasChecked = true;
			if (auth.state.status === 'signed-out') return;

			const source = openLocalSource();
			let count = 0;
			try {
				await source.whenLoaded;
				count = source.tables.recordings.count();
			} finally {
				source.dispose();
			}
			if (count === 0) return;
			recordingCount = count;
			open = true;
		},

		/** Copy local data into the owner doc, then delete the plaintext local copy. */
		async addToAccount(): Promise<void> {
			if (phase !== 'idle') return;
			phase = 'adding';
			const { error } = await tryAsync({
				try: async () => {
					const source = openLocalSource();
					try {
						await source.whenLoaded;
						await addLocalToOwner(source);
					} finally {
						source.dispose();
					}
				},
				catch: (cause) => SignInMigrationError.AddFailed({ cause }),
			});
			phase = 'idle';
			if (error) {
				// Local copy is untouched on failure; the dialog stays open to retry.
				toastOnError(error, error.message);
				return;
			}
			open = false;
		},

		/** Delete the plaintext local copy without copying it into the account. */
		async deleteFromDevice(): Promise<void> {
			if (phase !== 'idle') return;
			phase = 'deleting';
			const { error } = await tryAsync({
				try: async () => {
					const source = openLocalSource();
					try {
						await source.whenLoaded;
						await source.clearLocal();
					} finally {
						source.dispose();
					}
				},
				catch: (cause) => SignInMigrationError.DeleteFailed({ cause }),
			});
			phase = 'idle';
			if (error) {
				toastOnError(error, error.message);
				return;
			}
			open = false;
		},

		/** Defer: close the dialog. The next signed-in boot re-probes and nags. */
		keepForNow(): void {
			if (phase !== 'idle') return;
			open = false;
		},
	};
}

export const signInMigration = createSignInMigration();
