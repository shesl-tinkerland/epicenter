/**
 * Attach a desktop-only materializer that mirrors the `recordings` table into
 * `{id}.md` files on disk. No-op in the browser.
 *
 * Observes the table and invokes Tauri Rust commands through a serialized
 * promise chain so rapid
 * changes never produce overlapping writes.
 */

import type { Table } from '@epicenter/workspace';
import yaml from 'js-yaml';
import { defineErrors } from 'wellcrafted/error';
import { createLogger } from 'wellcrafted/logger';
import type * as Y from 'yjs';
import { tauri } from './tauri';
import { commands } from './tauri/commands';
import type { Recording } from './workspace';

const log = createLogger('whispering/recording-materializer');
const RecordingMaterializerError = defineErrors({
	WriteFailed: ({ cause }: { cause: unknown }) => ({
		message: 'Failed to write recording markdown files',
		cause,
	}),
});

type RecordingMarkdownFilesAttachment = {
	/** Resolves after the initial flush of existing rows completes. */
	whenFlushed: Promise<void>;
};

/**
 * Serialize a recording row to a markdown file.
 *
 * Puts `transcript` in the body and all other metadata in YAML frontmatter.
 */
function toRecordingMarkdownFile(row: Recording) {
	const { transcript, ...frontmatter } = row;
	const yamlStr = yaml.dump(frontmatter, { lineWidth: -1 });
	return {
		filename: `${row.id}.md`,
		content: `---\n${yamlStr}---\n${transcript || ''}\n`,
	};
}

export function attachRecordingMarkdownFiles(
	ydoc: Y.Doc,
	recordings: Table<Recording>,
	config: {
		waitFor: Promise<unknown>;
	},
) {
	if (!tauri) {
		return {
			whenFlushed: Promise.resolve(),
		} satisfies RecordingMarkdownFilesAttachment;
	}

	// Serialized promise chain: observer batches complete sequentially so
	// rapid changes don't produce overlapping Rust invoke calls.
	let syncQueue = Promise.resolve();

	const unsubscribe = recordings.observe((changedIds) => {
		syncQueue = syncQueue
			.then(async () => {
				const toWrite: { filename: string; content: string }[] = [];
				const toDelete: string[] = [];

				for (const id of changedIds) {
					const { data: row, error } = recordings.get(id);
					if (error) continue; // invalid row, leave existing file alone
					if (row === null) {
						toDelete.push(`${id}.md`);
					} else {
						toWrite.push(toRecordingMarkdownFile(row));
					}
				}

				if (toWrite.length) {
					const { error } = await commands.writeRecordingMarkdownFiles(toWrite);
					if (error !== null) throw error;
				}
				if (toDelete.length) {
					const { error } = await commands.deleteRecordingFiles(toDelete);
					if (error !== null) throw error;
				}
			})
			.catch((error) => {
				log.warn(RecordingMaterializerError.WriteFailed({ cause: error }));
			});
	});

	const whenFlushed = (async () => {
		await config.waitFor;
		syncQueue = syncQueue.then(async () => {
			const files = recordings.getAllValid().map(toRecordingMarkdownFile);
			if (files.length) {
				const { error } = await commands.writeRecordingMarkdownFiles(files);
				if (error !== null) throw error;
			}
		});
		await syncQueue;
	})();

	ydoc.once('destroy', () => {
		unsubscribe();
	});

	return { whenFlushed } satisfies RecordingMarkdownFilesAttachment;
}
