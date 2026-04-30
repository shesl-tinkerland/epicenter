/**
 * Per-entry content Y.Doc builder. Pure: takes an `entryId` plus all the
 * deps the construction needs and returns a Disposable bundle. Wire into a
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
import type { Entry, EntryId } from '$lib/workspace';

export type EntryContentDoc = {
	ydoc: Y.Doc;
	body: ReturnType<typeof attachRichText>;
	whenReady: Promise<unknown>;
	[Symbol.dispose](): void;
};

export function createEntryContentDoc({
	entryId,
	workspaceId,
	entriesTable,
	auth,
	apiUrl,
}: {
	entryId: EntryId;
	workspaceId: string;
	entriesTable: Table<Entry>;
	auth: Pick<AuthCore, 'getToken'>;
	apiUrl: string;
}): EntryContentDoc {
	const ydoc = new Y.Doc({
		guid: docGuid({
			workspaceId,
			collection: 'entries',
			rowId: entryId,
			field: 'content',
		}),
		gc: false,
	});
	const body = attachRichText(ydoc);
	const idb = attachIndexedDb(ydoc);
	// Token sourced via getToken on each connect attempt — token rotations are
	// picked up on natural reconnects without disrupting an open content-doc
	// connection. The workspace-level client owns the "force reconnect on
	// session change" decision.
	attachSync(ydoc, {
		url: toWsUrl(`${apiUrl}/docs/${ydoc.guid}`),
		waitFor: idb.whenLoaded,
		getToken: async () => auth.getToken(),
	});

	onLocalUpdate(ydoc, () => {
		entriesTable.update({
			id: entryId,
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
