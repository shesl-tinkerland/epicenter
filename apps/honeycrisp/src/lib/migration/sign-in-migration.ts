/**
 * Honeycrisp's wiring of the shared first-sign-in migration
 * (`@epicenter/app-shell/sign-in-migration`): the local-source opener and the
 * words are app-side; the probe / Add / Delete / Keep mechanics are shared.
 *
 * The shared kit only copies table rows (`notes`, `folders`); it has no
 * concept of a note's body. A note's rich-text content lives in its own
 * per-row `Y.Doc` (`notesTable.docs({ body })`), wired outside `.connect()`
 * (see `$lib/workspace/browser.ts`), so `addToAccount` here wraps the shared
 * state and layers a second phase on top: after the row copy succeeds, copy
 * every migrated note's body content from the bare local doc's storage into
 * the signed-in owner-scoped storage. Skipping this step would migrate a
 * note's title and folder but silently leave its actual text behind.
 */

import { createSignInMigration } from '@epicenter/app-shell/sign-in-migration';
import type { SignInMigrationState } from '@epicenter/app-shell/sign-in-migration';
import { attachIndexedDb, attachLocalStorage } from '@epicenter/workspace';
import * as Y from 'yjs';
import { auth } from '#platform/auth';
import { honeycrisp } from '$lib/honeycrisp';
import { honeycrispWorkspace } from '$lib/workspace';

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

const baseMigration = createSignInMigration({
	auth,
	openLocalSource,
	target: honeycrisp,
	describe: describeLocalContents,
	errorNoun: 'notes',
});

/**
 * Merge one note's bare-local body content into its owner-scoped storage.
 *
 * Reads the bare doc's full Yjs state, then applies it onto the owner-scoped
 * doc (both keyed by the same guid; only the storage partition differs). CRDT
 * merge is commutative, so this is safe to run even if the owner-scoped doc
 * already has content (e.g. a retry). Local storage only, no relay
 * connection: the next time the note opens, the normal signed-in boot path
 * (`connectLocalFirst`) connects that same doc to the relay and syncs the
 * merged content out.
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

/**
 * Wraps `baseMigration` with the body-content step. Every getter and every
 * other method delegates straight through; only `addToAccount` gains a
 * second phase, run after the shared row copy succeeds.
 */
export const signInMigration: SignInMigrationState = {
	get open() {
		return baseMigration.open;
	},
	set open(value) {
		baseMigration.open = value;
	},
	get summary() {
		return baseMigration.summary;
	},
	get note() {
		return baseMigration.note;
	},
	get phase() {
		return baseMigration.phase;
	},
	get isBusy() {
		return baseMigration.isBusy;
	},
	check: () => baseMigration.check(),
	async addToAccount() {
		const source = openLocalSource();
		let noteBodyGuids: string[] = [];
		try {
			await source.whenLoaded;
			noteBodyGuids = source.tables.notes
				.scan()
				.rows.map((row) => source.tables.notes.docs.body.guid(row.id));
		} finally {
			source.dispose();
		}

		await baseMigration.addToAccount();
		// The base state closes the dialog (`open` false) only on success; a
		// failure leaves it open so the user can retry, and this step must not
		// run against rows that never made it to the owner doc.
		if (baseMigration.open) return;
		if (auth.state.status === 'signed-out') return;

		const scope = {
			server: new URL(auth.baseURL).host,
			ownerId: auth.state.ownerId,
		};
		for (const guid of noteBodyGuids) {
			await migrateNoteBody(guid, scope);
		}
	},
	deleteFromDevice: () => baseMigration.deleteFromDevice(),
	keepForNow: () => baseMigration.keepForNow(),
};
