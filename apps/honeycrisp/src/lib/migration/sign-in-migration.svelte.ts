/**
 * Honeycrisp's wiring of the shared first-sign-in migration
 * (`@epicenter/app-shell/sign-in-migration`): the local-source opener and the
 * words are app-side; the probe / Add / Delete / Keep mechanics are shared.
 *
 * The shared kit only copies table rows (`notes`, `folders`); it has no
 * concept of a note's body. A note's rich-text content lives in its own
 * per-row `Y.Doc` (`notesTable.docs({ body })`), wired outside the kit (see
 * `$lib/workspace/browser.ts`), so this wraps the shared state with a body
 * phase. Ordering is the crash-safety invariant:
 *
 *   Add:    merge bodies into owner storage FIRST (idempotent CRDT merge),
 *           then the shared row copy + root clear, then best-effort deletion
 *           of the bare plaintext body copies. A crash at any point leaves
 *           either the root rows intact (so the dialog re-prompts and the
 *           idempotent merge re-runs) or everything already safe in owner
 *           storage with only removable residue behind.
 *   Delete: clear the bare bodies FIRST, then the shared root clear. A crash
 *           in between leaves the root rows intact, so the dialog re-prompts
 *           and the deletion converges.
 *
 * The wrapper's own `phase` overlays the base's so the dialog stays busy and
 * undismissable through the body work, and every body failure surfaces as a
 * toast with the dialog still open for retry.
 */

import {
	createSignInMigration,
	type SignInMigrationState,
} from '@epicenter/app-shell/sign-in-migration';
import { toastOnError } from '@epicenter/ui/sonner';
import { attachIndexedDb, attachLocalStorage } from '@epicenter/workspace';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { tryAsync } from 'wellcrafted/result';
import * as Y from 'yjs';
import { auth } from '#platform/auth';
import { honeycrisp } from '$lib/honeycrisp';
import { honeycrispWorkspace } from '$lib/workspace';
import { clearBareDoc } from '$lib/workspace/clear-bare-doc';

const BodyMigrationError = defineErrors({
	BodiesFailed: ({ cause }: { cause: unknown }) => ({
		message: `Could not move your note text into this account: ${extractErrorMessage(cause)}`,
		cause,
	}),
	BodyDeleteFailed: ({ cause }: { cause: unknown }) => ({
		message: `Could not remove the local note text: ${extractErrorMessage(cause)}`,
		cause,
	}),
	BodyCleanupFailed: ({ cause }: { cause: unknown }) => ({
		message: `Your notes are in your account, but removing the leftover local copies failed: ${extractErrorMessage(cause)}`,
		cause,
	}),
});
type BodyMigrationError = InferErrors<typeof BodyMigrationError>;

/**
 * Open a throwaway handle to the signed-out plaintext local doc (the migration
 * source). This opens the same `epicenter-honeycrisp` IndexedDB the
 * signed-out app uses; the owner doc's storage is partitioned, so this never
 * collides with the active synced doc. `dispose()` tears down the connection
 * without deleting data (`clearLocal` does the deletion).
 */
function openLocalSource() {
	const workspace = honeycrispWorkspace.create();
	const idb = attachIndexedDb(workspace.ydoc);
	return {
		tables: workspace.tables,
		whenLoaded: idb.whenLoaded,
		clearLocal: idb.clearLocal,
		dispose: () => workspace.ydoc.destroy(),
	};
}

/**
 * Human phrase for what is staged locally, e.g. "3 notes", "2 folders", or
 * "3 notes and 2 folders".
 */
function describeLocalContents(counts: Record<string, number>): string {
	const parts: string[] = [];
	const notes = counts.notes ?? 0;
	if (notes > 0) parts.push(`${notes} note${notes === 1 ? '' : 's'}`);
	const folders = counts.folders ?? 0;
	if (folders > 0) parts.push(`${folders} folder${folders === 1 ? '' : 's'}`);
	return parts.length > 0 ? parts.join(' and ') : 'data';
}

/** Body-doc guids for every note currently staged in the bare local doc. */
async function readLocalBodyGuids(): Promise<string[]> {
	const source = openLocalSource();
	try {
		await source.whenLoaded;
		return source.tables.notes
			.scan()
			.rows.map((row) => source.tables.notes.docs.body.guid(row.id));
	} finally {
		source.dispose();
	}
}

/**
 * Merge one note's bare-local body content into its owner-scoped storage.
 *
 * Reads the bare doc's full Yjs state, then applies it onto the owner-scoped
 * doc (both keyed by the same guid; only the storage partition differs). CRDT
 * merge is commutative and idempotent, so a retry is always safe. Local
 * storage only, no relay connection: the next time the note opens, the normal
 * signed-in boot path (`connectLocalFirst`) connects that same doc to the
 * relay and syncs the merged content out. The bare copy is NOT deleted here;
 * deletion happens only after the whole Add succeeds.
 */
async function migrateNoteBody(
	guid: string,
	scope: Parameters<typeof attachLocalStorage>[1],
): Promise<void> {
	const bareDoc = new Y.Doc({ guid, gc: true });
	const bareIdb = attachIndexedDb(bareDoc);
	await bareIdb.whenLoaded;
	const update = Y.encodeStateAsUpdate(bareDoc);
	bareDoc.destroy();
	await bareIdb.whenDisposed;
	// An empty Yjs update is 2 bytes (no client blocks). Skip the round trip
	// for a note whose body was never opened locally.
	if (update.byteLength <= 2) return;

	const ownerDoc = new Y.Doc({ guid, gc: true });
	const ownerIdb = attachLocalStorage(ownerDoc, scope);
	await ownerIdb.whenLoaded;
	Y.applyUpdate(ownerDoc, update);
	ownerDoc.destroy();
	await ownerIdb.whenDisposed;
}

function ownerScope(): Parameters<typeof attachLocalStorage>[1] {
	const state = auth.state;
	if (state.status === 'signed-out') {
		// Unreachable: the dialog only opens on a signed-in boot, and an owner
		// change reloads the page before this could run.
		throw new Error('[sign-in-migration] owner scope read while signed out.');
	}
	return { server: new URL(auth.baseURL).host, ownerId: state.ownerId };
}

const baseMigration = createSignInMigration({
	auth,
	openLocalSource,
	target: honeycrisp,
	describe: describeLocalContents,
	errorNoun: 'notes',
});

let bodyPhase = $state<'idle' | 'adding' | 'deleting'>('idle');

/**
 * The shared migration state with Honeycrisp's body phase layered on. Every
 * getter delegates to the base; `phase`/`isBusy`/the `open` setter overlay
 * the body work so the dialog stays busy and undismissable through it.
 */
export const signInMigration: SignInMigrationState = {
	get open() {
		return baseMigration.open;
	},
	set open(value) {
		if (bodyPhase !== 'idle') return;
		baseMigration.open = value;
	},
	get summary() {
		return baseMigration.summary;
	},
	get note() {
		return baseMigration.note;
	},
	get phase() {
		return bodyPhase !== 'idle' ? bodyPhase : baseMigration.phase;
	},
	get isBusy() {
		return bodyPhase !== 'idle' || baseMigration.isBusy;
	},
	check: () => baseMigration.check(),

	async addToAccount() {
		if (bodyPhase !== 'idle' || baseMigration.isBusy) return;

		// Phase 1: bodies first. On failure the root rows are untouched, so the
		// dialog stays open and a retry re-runs the idempotent merge.
		bodyPhase = 'adding';
		let bodyGuids: string[] = [];
		const { error: bodiesError } = await tryAsync({
			try: async () => {
				bodyGuids = await readLocalBodyGuids();
				const scope = ownerScope();
				for (const guid of bodyGuids) {
					await migrateNoteBody(guid, scope);
				}
			},
			catch: (cause) => BodyMigrationError.BodiesFailed({ cause }),
		});
		bodyPhase = 'idle';
		if (bodiesError) {
			toastOnError(bodiesError, bodiesError.message);
			return;
		}

		// Phase 2: the shared row copy + root clear. On failure the base keeps
		// the dialog open; the already-merged bodies are harmless (idempotent).
		await baseMigration.addToAccount();
		if (baseMigration.open) return;

		// Phase 3: best-effort removal of the lingering plaintext bare body
		// copies. Everything is already safe in owner storage, so a failure
		// here only leaves removable residue behind.
		const { error: cleanupError } = await tryAsync({
			try: async () => {
				for (const guid of bodyGuids) {
					await clearBareDoc(guid);
				}
			},
			catch: (cause) => BodyMigrationError.BodyCleanupFailed({ cause }),
		});
		if (cleanupError) toastOnError(cleanupError, cleanupError.message);
	},

	async deleteFromDevice() {
		if (bodyPhase !== 'idle' || baseMigration.isBusy) return;

		// Bodies first: a crash in between leaves the root rows intact, so the
		// dialog re-prompts and the deletion converges on retry.
		bodyPhase = 'deleting';
		const { error } = await tryAsync({
			try: async () => {
				const bodyGuids = await readLocalBodyGuids();
				for (const guid of bodyGuids) {
					await clearBareDoc(guid);
				}
			},
			catch: (cause) => BodyMigrationError.BodyDeleteFailed({ cause }),
		});
		bodyPhase = 'idle';
		if (error) {
			toastOnError(error, error.message);
			return;
		}
		await baseMigration.deleteFromDevice();
	},

	keepForNow: () => {
		if (bodyPhase !== 'idle') return;
		baseMigration.keepForNow();
	},
};
