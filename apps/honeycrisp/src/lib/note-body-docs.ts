/**
 * Per-note body Y.Doc builder. Pure: takes a `noteId` plus all the deps the
 * construction needs and returns a Disposable bundle. Wire into a
 * `createDisposableCache` at the workspace module scope (see
 * `client.svelte.ts`) for refcount + grace.
 */

import type { AuthCore } from '@epicenter/auth-svelte';
import {
	attachIndexedDb,
	attachRichText,
	attachSync,
	DateTimeString,
	docGuid,
	onLocalUpdate,
	type Table,
	toWsUrl,
} from '@epicenter/workspace';
import * as Y from 'yjs';
import type { Note, NoteId } from '$lib/workspace';

export type NoteBodyDoc = {
	ydoc: Y.Doc;
	body: ReturnType<typeof attachRichText>;
	whenReady: Promise<unknown>;
	[Symbol.dispose](): void;
};

export function createNoteBodyDoc({
	noteId,
	workspaceId,
	notesTable,
	auth,
	apiUrl,
}: {
	noteId: NoteId;
	workspaceId: string;
	notesTable: Table<Note>;
	auth: Pick<AuthCore, 'getToken'>;
	apiUrl: string;
}): NoteBodyDoc {
	const ydoc = new Y.Doc({
		guid: docGuid({
			workspaceId,
			collection: 'notes',
			rowId: noteId,
			field: 'body',
		}),
		gc: false,
	});
	const body = attachRichText(ydoc);
	const idb = attachIndexedDb(ydoc);
	// Token sourced via getToken on each connect attempt — token rotations are
	// picked up on natural reconnects without disrupting an open note-body
	// connection. The workspace-level client owns the "force reconnect on
	// session change" decision.
	attachSync(ydoc, {
		url: toWsUrl(`${apiUrl}/docs/${ydoc.guid}`),
		waitFor: idb.whenLoaded,
		getToken: () => auth.getToken(),
	});

	onLocalUpdate(ydoc, () => {
		notesTable.update({
			id: noteId,
			updatedAt: DateTimeString.now(),
		});
	});

	return {
		ydoc,
		body,
		whenReady: idb.whenLoaded,
		[Symbol.dispose]() {
			ydoc.destroy();
		},
	};
}
