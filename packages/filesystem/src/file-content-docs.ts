/**
 * Per-file content Y.Doc builder. Pure: takes a `fileId` plus all the deps
 * the construction needs and returns a Disposable bundle. The builder owns
 * Y.Doc construction + timeline attachment + `updatedAt` writeback;
 * persistence is caller-owned via the `attachPersistence` callback —
 *
 *   // browser
 *   attachPersistence: (ydoc) => attachIndexedDb(ydoc),
 *
 *   // desktop / CLI — caller closes over a directory
 *   attachPersistence: (ydoc) => attachYjsLog(ydoc, {
 *     filePath: join(contentDir, `${ydoc.guid}.db`),
 *   }),
 *
 *   // omit for in-memory (tests, Node stubs)
 *
 * The callback's return value is threaded: `whenLoaded` surfaces on
 * `whenReady`, `whenDisposed` is available on the persistence handle for
 * teardown barriers.
 *
 * Wire into a `createDisposableCache` at the workspace module scope (see
 * `apps/opensidian/src/lib/client.svelte.ts`) for refcount + grace.
 */

import type { DisposableCache, Table } from '@epicenter/workspace';
import {
	attachTimeline,
	docGuid,
	type DocPersistence,
	onLocalUpdate,
} from '@epicenter/workspace';
import * as Y from 'yjs';
import type { FileId } from './ids.js';
import type { FileRow } from './table.js';

export type FileContentDoc = {
	ydoc: Y.Doc;
	content: ReturnType<typeof attachTimeline>;
	persistence: DocPersistence | undefined;
	whenReady: Promise<unknown>;
	[Symbol.dispose](): void;
};

/**
 * Cross-package alias for the cache that holds opened FileContentDoc
 * handles. Exported so consumers (the filesystem ops layer, sqlite-index
 * extension, e2e configs) can declare a single shared type instead of
 * spelling out `DisposableCache<FileId, FileContentDoc>` at every site.
 */
export type FileContentDocs = DisposableCache<FileId, FileContentDoc>;

export function createFileContentDoc({
	fileId,
	workspaceId,
	filesTable,
	attachPersistence,
}: {
	fileId: FileId;
	workspaceId: string;
	filesTable: Table<FileRow>;
	attachPersistence?: (ydoc: Y.Doc) => DocPersistence;
}): FileContentDoc {
	const ydoc = new Y.Doc({
		guid: docGuid({
			workspaceId,
			collection: 'files',
			rowId: fileId,
			field: 'content',
		}),
		gc: false,
	});
	onLocalUpdate(ydoc, () =>
		filesTable.update({ id: fileId, updatedAt: Date.now() }),
	);
	const persistence = attachPersistence?.(ydoc);
	return {
		ydoc,
		content: attachTimeline(ydoc),
		persistence,
		whenReady: persistence?.whenLoaded ?? Promise.resolve(),
		[Symbol.dispose]() {
			ydoc.destroy();
		},
	};
}
