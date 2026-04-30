import type { AuthClient } from '@epicenter/auth-svelte';
import { APP_URLS } from '@epicenter/constants/vite';
import {
	attachBroadcastChannel,
	attachIndexedDb,
	attachSync,
	createDisposableCache,
	type DeviceDescriptor,
	toWsUrl,
} from '@epicenter/workspace';
import { createNoteBodyDoc } from '$lib/note-body-docs';
import type { NoteId } from '$lib/workspace';
import { openHoneycrisp as openHoneycrispDoc } from './core';

export function openHoneycrisp({
	auth,
	device,
}: {
	auth: AuthClient;
	device: DeviceDescriptor;
}) {
	const doc = openHoneycrispDoc();

	const idb = attachIndexedDb(doc.ydoc);
	attachBroadcastChannel(doc.ydoc);

	const noteBodyDocs = createDisposableCache(
		(noteId: NoteId) =>
			createNoteBodyDoc({
				noteId,
				workspaceId: doc.ydoc.guid,
				notesTable: doc.tables.notes,
				auth,
				apiUrl: APP_URLS.API,
			}),
		{ gcTime: 5_000 },
	);

	const sync = attachSync(doc, {
		url: toWsUrl(`${APP_URLS.API}/workspaces/${doc.ydoc.guid}`),
		waitFor: idb,
		device,
		getToken: async () => auth.getToken(),
	});

	return {
		...doc,
		idb,
		noteBodyDocs,
		sync,
		/**
		 * Resolves when IndexedDB has hydrated the local snapshot — the UI can
		 * render with persisted data. Does NOT gate sync (the WebSocket can
		 * connect at any time, including never if the user is offline).
		 */
		whenReady: idb.whenLoaded,
	};
}
