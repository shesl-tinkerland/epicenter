/**
 * Tauri runtime client for Whispering.
 *
 * Builds the workspace, attaches IndexedDB persistence and same-device
 * broadcast sync, and adds native actions only available in the desktop app.
 */

import {
	attachBroadcastChannel,
	attachIndexedDb,
	defineActions,
	defineMutation,
	defineWorkspace,
} from '@epicenter/workspace';
import { attachMarkdownExport } from '@epicenter/workspace/document/materializer/markdown';
import { open } from '@tauri-apps/plugin-dialog';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { createLogger } from 'wellcrafted/logger';
import { type Result, tryAsync } from 'wellcrafted/result';
import { PATHS } from '$lib/services/fs-paths';
import { commands } from '$lib/tauri/commands';
import { createWhispering, type Recording } from '$lib/workspace';
import {
	assembleMarkdown,
	tauriMarkdownDeps,
} from '$lib/workspace/markdown-export-fs';

const RecordingMarkdownExportError = defineErrors({
	WriteFailed: ({ cause }: { cause: unknown }) => ({
		message: `Failed to write recording markdown files: ${extractErrorMessage(cause)}`,
		cause,
	}),
});
type RecordingMarkdownExportError = InferErrors<
	typeof RecordingMarkdownExportError
>;

const log = createLogger('whispering/markdown-export');

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
		defaultTranscriptionService: 'parakeet',
	});

	const idb = attachIndexedDb(workspace.ydoc);
	attachBroadcastChannel(workspace.ydoc);

	// Continuously materialize each recording to a plain-Markdown sidecar beside
	// its audio in the appdata `recordings/` folder: `{id}.md` next to `{id}.wav`.
	// One-way Yjs -> disk; the observer rewrites on edit and removes the file when
	// a recording is deleted. This is the always-on counterpart to the manual
	// `recordings_export_markdown` action below, which snapshots to a folder the
	// user picks. Gated on local hydration so the first flush sees every recording,
	// not an empty doc. The Rust artifact layer already preserves these sidecars
	// when audio is cleared.
	const recordingMarkdown = attachMarkdownExport(workspace, {
		dir: () => PATHS.DB.RECORDINGS(),
		...tauriMarkdownDeps,
		waitFor: idb.whenLoaded,
		log,
		tables: {
			recordings: {
				// No per-table subdir: write straight into `recordings/` so the
				// sidecar sits beside the audio file of the same id.
				dir: '',
				// Mirror the manual export's shape: the transcript is the file body,
				// every other column is frontmatter.
				toMarkdown: (recording) => {
					const { transcript, ...frontmatter } = recording;
					return { frontmatter, body: transcript || undefined };
				},
			},
		},
	});
	// Per-row write failures log inside the export; a cold-start flush rejection
	// (e.g. the batch write command erroring) surfaces here instead of as an
	// unhandled rejection.
	recordingMarkdown.whenFlushed.catch((cause) => {
		log.warn(
			new Error(
				`initial recording markdown flush failed: ${extractErrorMessage(cause)}`,
			),
		);
	});

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
								.scan()
								.rows.map((row: Recording) => {
									const { transcript, ...frontmatter } = row;
									return {
										filename: `${row.id}.md`,
										content: assembleMarkdown(
											frontmatter,
											transcript || undefined,
										),
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
