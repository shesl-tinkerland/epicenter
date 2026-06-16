/**
 * Honeycrisp workspace contract: id, branded types, tables, actions, and
 * per-row child document models. Isomorphic: no IndexedDB, WebSockets, SQLite
 * files, Svelte state, or daemon process lifecycle.
 *
 * Distribution: `apps/honeycrisp/package.json` exports this file as the
 * `@epicenter/honeycrisp` package root. Browser code, daemon code, and tests
 * all import from here. The table shapes here are the wire contract for sync;
 * forking a column shape breaks sync compatibility with peers running the
 * canonical schema.
 *
 * Composition lives elsewhere:
 *  - `apps/honeycrisp/honeycrisp.browser.ts`  -> `openHoneycrispBrowser({ signedIn, nodeId })`
 *  - `apps/honeycrisp/mount.ts`  -> `honeycrisp(opts?)` mount factory
 */

import { field } from '@epicenter/field';
import {
	attachRichText,
	defineActions,
	defineMutation,
	defineTable,
	defineWorkspace,
	generateId,
	type InferTableRow,
	nullable,
	type WorkspaceFromDefinition,
} from '@epicenter/workspace';
import Type from 'typebox';
import type { Brand } from 'wellcrafted/brand';

export const HONEYCRISP_ID = 'epicenter-honeycrisp';

// ─── Branded IDs ──────────────────────────────────────────────────────────────

/**
 * Branded note ID: nanoid generated when a note is created.
 *
 * Prevents accidental mixing with other string IDs at compile time.
 */
export type NoteId = string & Brand<'NoteId'>;

/**
 * Syntactic sugar for `value as NoteId`. The constrained `string` parameter
 * is what earns it over a raw `as` cast (callers can't widen to `unknown`).
 * The only place in the codebase where `as NoteId` should appear.
 */
export const asNoteId = (value: string): NoteId => value as NoteId;

/** Generate a unique {@link NoteId} for a new note row. */
export const generateNoteId = (): NoteId => generateId<NoteId>();

/**
 * Branded folder ID: nanoid generated when a folder is created.
 *
 * Prevents accidental mixing with other string IDs at compile time.
 */
export type FolderId = string & Brand<'FolderId'>;

/**
 * Syntactic sugar for `value as FolderId`. The constrained `string` parameter
 * is what earns it over a raw `as` cast (callers can't widen to `unknown`).
 * The only place in the codebase where `as FolderId` should appear.
 */
export const asFolderId = (value: string): FolderId => value as FolderId;

/** Generate a unique {@link FolderId} for a new folder row. */
export const generateFolderId = (): FolderId => generateId<FolderId>();

// ─── Tables ───────────────────────────────────────────────────────────────────

/**
 * Folders table: organizational containers for notes.
 *
 * Each folder has a name, optional emoji icon, and sort order for manual
 * reordering in the sidebar. Notes reference folders via `folderId`.
 */
const foldersTable = defineTable({
	id: field.string<FolderId>(),
	name: field.string(),
	icon: nullable(field.string()),
	sortOrder: field.number(),
});
export type Folder = InferTableRow<typeof foldersTable>;

/**
 * Notes table: individual notes with rich-text bodies.
 *
 * Each note belongs to an optional folder (unfiled if `folderId` is null),
 * has a title auto-populated from the first line of content, a preview for the
 * list view, and can be pinned to appear at the top of the note list.
 *
 * `deletedAt` is `null` for active notes and an `InstantString` for deleted
 * notes. `wordCount` is computed on each editor update.
 *
 * The Y.XmlFragment document (`body`) lives in a separate Y.Doc per note,
 * declared as a child doc on this table.
 */
const notesTable = defineTable({
	id: field.string<NoteId>(),
	folderId: nullable(field.string<FolderId>()),
	title: field.string(),
	preview: field.string(),
	pinned: field.boolean(),
	createdAt: field.instant(),
	updatedAt: field.instant(),
	deletedAt: nullable(field.instant()),
	wordCount: nullable(field.number()),
}).docs({
	body: {
		layout: attachRichText,
		touch: 'updatedAt',
	},
});
export type Note = InferTableRow<typeof notesTable>;

// ─── Workspace factory ────────────────────────────────────────────────────────

/**
 * Honeycrisp's shared workspace definition.
 *
 * Runtime openers attach persistence, sync, materializers, and UI state around
 * this shared model.
 */
export const honeycrispWorkspace = defineWorkspace({
	id: HONEYCRISP_ID,
	tables: { folders: foldersTable, notes: notesTable },
	kv: {},
	actions: ({ tables }) =>
		defineActions({
			/**
			 * Delete a folder and move all its notes to unfiled.
			 *
			 * Re-parents every note in the folder (sets `folderId` to null)
			 * and deletes the folder row. Selection clearing is handled by the
			 * Svelte state layer (folders) via URL search params.
			 */
			folders_delete: defineMutation({
				description: 'Delete a folder and re-parent its notes to unfiled',
				input: Type.Object({ folderId: Type.String() }),
				handler: ({ folderId: rawId }) => {
					const folderId = asFolderId(rawId);
					const folderNotes = tables.notes
						.scan()
						.rows.filter((n) => n.folderId === folderId);
					for (const note of folderNotes) {
						tables.notes.update(note.id, { folderId: null });
					}
					tables.folders.delete(folderId);
				},
			}),
		}),
});
export type HoneycrispWorkspace = WorkspaceFromDefinition<
	typeof honeycrispWorkspace
>;
