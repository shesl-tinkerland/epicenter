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

const RecordingMarkdownExportError = defineErrors({
	WriteFailed: ({ cause }: { cause: unknown }) => ({
		message: `Failed to write recording markdown files: ${extractErrorMessage(cause)}`,
		cause,
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

							const files = workspace.tables.recordings
								.getAllValid()
								.map((row: Recording) => {
									const { transcript, ...frontmatter } = row;
									const yamlStr = yaml.dump(frontmatter, { lineWidth: -1 });
									return {
										filename: `${row.id}.md`,
										content: `---\n${yamlStr}---\n${transcript || ''}\n`,
									};
								});
							const { error } = await commands.writeMarkdownFiles(
								selected,
								files,
							);
							if (error !== null) throw error;
							return {
								status: 'exported',
								dir: selected,
								written: files.length,
							};
						},
						catch: (error) =>
							RecordingMarkdownExportError.WriteFailed({ cause: error }),
					}),
			}),
		}),
		whenReady: idb.whenLoaded,
	});
}

export const whispering = openWhispering();
