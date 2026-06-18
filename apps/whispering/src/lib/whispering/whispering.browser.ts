/**
 * Browser runtime client for Whispering.
 *
 * Keeps the local-first workspace usable on the web with the same action set as
 * the Tauri client. The recordings export is shared: the `#platform/download`
 * seam turns it into a browser download here and a Save dialog on desktop.
 */

import {
	attachBroadcastChannel,
	attachIndexedDb,
	defineActions,
	satisfiesWorkspace,
} from '@epicenter/workspace';
import { createWhispering } from '$lib/workspace';
import { defineRecordingsMarkdownExport } from './recordings-markdown-export';

export function openWhispering() {
	const workspace = createWhispering({
		defaultTranscriptionService: 'OpenAI',
	});

	const idb = attachIndexedDb(workspace.ydoc);
	attachBroadcastChannel(workspace.ydoc);

	return satisfiesWorkspace({
		...workspace,
		actions: defineActions({
			...workspace.actions,
			recordings_export_markdown: defineRecordingsMarkdownExport(
				workspace.tables.recordings,
			),
		}),
		whenReady: idb.whenLoaded,
	});
}

export const whispering = openWhispering();
