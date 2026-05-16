/**
 * Honeycrisp workspace: schema definition, branded IDs, and actions factory.
 *
 * Honeycrisp is an Apple Notes clone with three-column layout: sidebar folders,
 * note list, and rich-text editor. Folders organize notes; notes have Y.XmlFragment
 * bodies for collaborative editing via Tiptap + y-prosemirror.
 *
 * Contains branded NoteId/FolderId types, folders and notes table definitions
 * with DateTimeString timestamps, and the cross-table actions factory. The Y.Doc
 * is constructed in `browser.ts` (browser) and `blocks/script.ts` (Bun),
 * composing these tables with `attachTables`.
 *
 * Distribution: this file is both the `@epicenter/honeycrisp` npm root export
 * AND the `epicenter/honeycrisp/workspace` jsrepo block. The table shapes
 * here are the wire contract for sync: forking a column shape breaks sync
 * compatibility with peers running the canonical schema. Recipes (script.ts,
 * daemon-route.ts) are yours to edit freely. See apps/README.md for the
 * dual-channel convention.
 */

import {
	DateTimeString,
	defineActions,
	defineMutation,
	defineTable,
	type InferTableRow,
	type Tables,
} from '@epicenter/workspace';
import { type } from 'arktype';
import Type from 'typebox';
import type { Brand } from 'wellcrafted/brand';

export const HONEYCRISP_WORKSPACE_ID = 'epicenter.honeycrisp';

// ─── Branded IDs ──────────────────────────────────────────────────────────────

/**
 * Branded note ID: nanoid generated when a note is created.
 *
 * Prevents accidental mixing with other string IDs at compile time.
 */
export type NoteId = string & Brand<'NoteId'>;
export const NoteId = type('string').pipe((s): NoteId => s as NoteId);

/**
 * Branded folder ID: nanoid generated when a folder is created.
 *
 * Prevents accidental mixing with other string IDs at compile time.
 */
export type FolderId = string & Brand<'FolderId'>;
export const FolderId = type('string').pipe((s): FolderId => s as FolderId);

// ─── Tables ───────────────────────────────────────────────────────────────────

/**
 * Folders table: organizational containers for notes.
 *
 * Each folder has a name, optional emoji icon, and sort order for manual
 * reordering in the sidebar. Notes reference folders via `folderId`.
 */
const foldersTable = defineTable(
	type({
		id: FolderId,
		name: 'string',
		'icon?': 'string | undefined',
		sortOrder: 'number',
		_v: '1',
	}),
);
export type Folder = InferTableRow<typeof foldersTable>;

const noteBase = type({
	id: NoteId,
	'folderId?': FolderId.or('undefined'),
	title: 'string',
	preview: 'string',
	pinned: 'boolean',
	createdAt: DateTimeString,
	updatedAt: DateTimeString,
});

/**
 * Notes table: individual notes with rich-text bodies.
 *
 * Each note belongs to an optional folder (unfiled if `folderId` is undefined),
 * has a title auto-populated from the first line of content, a preview for the
 * list view, and can be pinned to appear at the top of the note list.
 *
 * v2 adds `deletedAt` for soft delete: notes move to "Recently Deleted"
 * instead of being permanently destroyed. The field is `undefined` for active
 * notes and a `DateTimeString` for deleted ones. Also adds optional `wordCount`
 * (computed on each editor update, `undefined` for legacy notes).
 *
 * The Y.XmlFragment document (`body`) lives in a separate Y.Doc per note.
 * The browser workspace setup constructs it and bumps `updatedAt` via
 * `onLocalUpdate`.
 */
const notesTable = defineTable(
	noteBase.merge({
		_v: '1',
	}),
	noteBase.merge({
		'deletedAt?': DateTimeString.or('undefined'),
		'wordCount?': 'number | undefined',
		_v: '2',
	}),
).migrate((row) => {
	switch (row._v) {
		case 1:
			return { ...row, deletedAt: undefined, _v: 2 };
		case 2:
			return row;
	}
});
export type Note = InferTableRow<typeof notesTable>;

// ─── Table map ─────────────────────────────────────────────────────────────────

/**
 * Table definitions for the honeycrisp workspace. Composed directly in
 * `client.ts` via `attachTables(ydoc, honeycrispTables)`. Kept separate so
 * actions and future consumers can derive their input types from one source
 * of truth.
 */
export const honeycrispTables = { folders: foldersTable, notes: notesTable };
export type HoneycrispTables = Tables<typeof honeycrispTables>;

// ─── Actions ──────────────────────────────────────────────────────────────────

/**
 * Cross-table mutations layered on workspace tables.
 *
 * Includes operations that touch multiple tables in a single logical action
 * (e.g. folder deletion with note re-parenting). Simple single-table CRUD
 * stays in the Svelte state files.
 */
export function createHoneycrispActions(tables: HoneycrispTables) {
	return defineActions({
		/**
		 * Delete a folder and move all its notes to unfiled.
		 *
		 * Re-parents every note in the folder (sets `folderId` to undefined)
		 * and deletes the folder row. Selection clearing is handled by the
		 * Svelte state layer (folders) via URL search params.
		 */
		folders_delete: defineMutation({
			description: 'Delete a folder and re-parent its notes to unfiled',
			input: Type.Object({ folderId: Type.String() }),
			handler: ({ folderId: rawId }) => {
				const folderId = rawId as FolderId;
				const folderNotes = tables.notes
					.getAllValid()
					.filter((n) => n.folderId === folderId);
				for (const note of folderNotes) {
					tables.notes.update(note.id, { folderId: undefined });
				}
				tables.folders.delete(folderId);
			},
		}),
	});
}
export type HoneycrispActions = ReturnType<typeof createHoneycrispActions>;
