/**
 * Tauri runtime client for Whispering.
 *
 * Builds the workspace, attaches IndexedDB persistence and same-device
 * broadcast sync, and registers the shared recordings export action (which
 * resolves to a native Save dialog through the `#platform/download` seam).
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
		defaultTranscriptionService: 'parakeet',
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
