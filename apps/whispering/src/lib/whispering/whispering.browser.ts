/**
 * Browser runtime client for Whispering.
 *
 * Keeps the local-first workspace usable on the web while exposing the same
 * action keys as the Tauri client. Native desktop actions return a typed
 * unsupported error here instead of importing Tauri plugins into the browser
 * bundle.
 */

import {
	attachBroadcastChannel,
	attachIndexedDb,
	defineActions,
	defineMutation,
	defineWorkspace,
} from '@epicenter/workspace';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import type { Result } from 'wellcrafted/result';
import { createWhispering } from '$lib/workspace';

const RecordingMarkdownExportError = defineErrors({
	Unsupported: () => ({
		message: 'Recording markdown export is only available in the desktop app.',
	}),
});
type RecordingMarkdownExportError = InferErrors<
	typeof RecordingMarkdownExportError
>;

type RecordingMarkdownExportResult =
	| {
			status: 'cancelled';
	  }
	| {
			status: 'exported';
			dir: string;
			written: number;
	  };

export function openWhispering() {
	const workspace = createWhispering({
		defaultTranscriptionService: 'OpenAI',
	});

	const idb = attachIndexedDb(workspace.ydoc);
	attachBroadcastChannel(workspace.ydoc);

	return defineWorkspace({
		...workspace,
		actions: defineActions({
			...workspace.actions,
			recordings_export_markdown: defineMutation({
				title: 'Export recording markdown',
				description: 'Export current recordings as markdown files',
				handler: async (): Promise<
					Result<RecordingMarkdownExportResult, RecordingMarkdownExportError>
				> => RecordingMarkdownExportError.Unsupported(),
			}),
		}),
		whenReady: idb.whenLoaded,
	});
}

export const whispering = openWhispering();
