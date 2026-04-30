/**
 * Per-reference content Y.Doc builder. Pure: takes a `referenceId` plus all
 * the deps the construction needs and returns a Disposable bundle. References
 * are tier-3 documentation loaded on demand — each reference file gets its
 * own Y.Doc with `attachPlainText`. Persistence is caller-owned via the
 * `attachPersistence` callback — see `createFileContentDoc` for the shape.
 *
 * Wire into a `createDisposableCache` at the workspace module scope for
 * refcount + grace.
 */

import type { Table } from '@epicenter/workspace';
import {
	attachPlainText,
	docGuid,
	type DocPersistence,
	onLocalUpdate,
} from '@epicenter/workspace';
import * as Y from 'yjs';
import type { Reference } from './tables.js';

export type ReferenceContentDoc = {
	ydoc: Y.Doc;
	content: ReturnType<typeof attachPlainText>;
	persistence: DocPersistence | undefined;
	/**
	 * Persistence's `whenLoaded` if it has one (e.g. `attachIndexedDb`),
	 * otherwise `undefined`. `await handle.whenReady` is safe in both
	 * cases — `await undefined` resolves to `undefined`.
	 */
	whenReady: Promise<unknown> | undefined;
	[Symbol.dispose](): void;
};

export function createReferenceContentDoc({
	referenceId,
	workspaceId,
	referencesTable,
	attachPersistence,
}: {
	referenceId: string;
	workspaceId: string;
	referencesTable: Table<Reference>;
	attachPersistence?: (ydoc: Y.Doc) => DocPersistence;
}): ReferenceContentDoc {
	const ydoc = new Y.Doc({
		guid: docGuid({
			workspaceId,
			collection: 'references',
			rowId: referenceId,
			field: 'content',
		}),
		gc: false,
	});
	onLocalUpdate(ydoc, () =>
		referencesTable.update({ id: referenceId, updatedAt: Date.now() }),
	);
	const persistence = attachPersistence?.(ydoc);
	return {
		ydoc,
		content: attachPlainText(ydoc),
		persistence,
		whenReady: persistence?.whenLoaded,
		[Symbol.dispose]() {
			ydoc.destroy();
		},
	};
}
