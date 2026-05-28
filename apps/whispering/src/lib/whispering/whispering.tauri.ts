/**
 * Tauri runtime client for Whispering.
 *
 * Creates the shared workspace model, attaches local persistence and
 * same-device broadcast sync, then adds native actions that are only available
 * in the desktop app.
 */

import {
	attachBroadcastChannel,
	attachIndexedDb,
	defineActions,
	defineMutation,
	defineWorkspace,
} from '@epicenter/workspace';
import { open } from '@tauri-apps/plugin-dialog';
import yaml from 'js-yaml';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { type Result, tryAsync } from 'wellcrafted/result';
import { commands } from '$lib/tauri/commands';
import type { Recording } from '$lib/workspace';
import { createWhisperingWorkspace } from './index';

export function openWhispering() {
	const workspace = createWhisperingWorkspace();

	const idb = attachIndexedDb(workspace.ydoc);
	attachBroadcastChannel(workspace.ydoc);

	return defineWorkspace({
		...workspace,
		actions: defineActions({
			...workspace.actions,
			/**
			 * Open a folder picker and write every current recording as markdown.
			 *
			 * This is a Tauri action because it touches the native dialog and
			 * filesystem command surfaces. It is a click-time snapshot: later edits
			 * in Whispering do not update the exported files.
			 */
			recordings_export_markdown: defineMutation({
				title: 'Export recording markdown',
				description: 'Export current recordings as markdown files',
				handler: async (): Promise<
					Result<RecordingMarkdownExportResult, RecordingMarkdownExportError>
				> =>
					tryAsync({
						try: async () => {
							const selected = await open({
								directory: true,
								multiple: false,
								title: 'Choose folder for recording markdown export',
							});
							if (typeof selected !== 'string') return { status: 'cancelled' };

	return {
		...workspace,
		idb,
		recordingsFs,
		whenReady: Promise.all([idb.whenLoaded, recordingsFs.whenFlushed]),
	};
}

export const whispering = openWhispering();
