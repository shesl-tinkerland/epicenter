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
 *  - `apps/honeycrisp/honeycrisp.browser.ts`  -> `openHoneycrispBrowser({ signedIn, deviceId })`
 *  - `apps/honeycrisp/project.ts`  -> `honeycrisp(opts?)` mount factory
 */

import {
	attachRichText,
	column,
	createDisposableCache,
	createWorkspace,
	DateTimeString,
	defineActions,
	defineMutation,
	defineTable,
	defineWorkspace,
	docGuid,
	generateId,
	type InferTableRow,
	type Keyring,
	onLocalUpdate,
	type Tables,
} from '@epicenter/workspace';
import Type from 'typebox';
import type { Brand } from 'wellcrafted/brand';
import * as Y from 'yjs';

export const HONEYCRISP_ID = 'epicenter.honeycrisp';

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
	id: column.string<FolderId>(),
	name: column.string(),
	icon: column.nullable(column.string()),
	sortOrder: column.number(),
});
export type Folder = InferTableRow<typeof foldersTable>;

/**
 * Notes table: individual notes with rich-text bodies.
 *
 * Each note belongs to an optional folder (unfiled if `folderId` is null),
 * has a title auto-populated from the first line of content, a preview for the
 * list view, and can be pinned to appear at the top of the note list.
 *
 * v2 adds `deletedAt` for soft delete: notes move to "Recently Deleted"
 * instead of being permanently destroyed. The field is `null` for active
 * notes and a `DateTimeString` for deleted ones. Also adds optional `wordCount`
 * (computed on each editor update, `null` for legacy notes).
 *
 * The Y.XmlFragment document (`body`) lives in a separate Y.Doc per note.
 * The workspace factory constructs the plain child-doc model and each runtime
 * opener attaches its own persistence and sync.
 */
const notesTable = defineTable(
	{
		id: column.string<NoteId>(),
		folderId: column.nullable(column.string<FolderId>()),
		title: column.string(),
		preview: column.string(),
		pinned: column.boolean(),
		createdAt: column.dateTime(),
		updatedAt: column.dateTime(),
	},
	{
		id: column.string<NoteId>(),
		folderId: column.nullable(column.string<FolderId>()),
		title: column.string(),
		preview: column.string(),
		pinned: column.boolean(),
		createdAt: column.dateTime(),
		updatedAt: column.dateTime(),
		deletedAt: column.nullable(column.dateTime()),
		wordCount: column.nullable(column.number()),
	},
).migrate(({ value, version }) => {
	switch (version) {
		case 1:
			return { ...value, deletedAt: null, wordCount: null };
		case 2:
			return value;
	}
});
export type Note = InferTableRow<typeof notesTable>;

// ─── Workspace factory ────────────────────────────────────────────────────────

const honeycrispTables = { folders: foldersTable, notes: notesTable };
type HoneycrispTables = typeof honeycrispTables;
type HoneycrispActionHost = { tables: Tables<HoneycrispTables> };

/**
 * Build a Honeycrisp workspace bundle:
 * `{ ydoc, tables, kv, actions, noteBodyDocs }`.
 *
 * Encrypted under the supplied keyring. Runtime openers attach persistence,
 * sync, materializers, and UI state around this shared model.
 */
export function createHoneycrispWorkspace(opts: { keyring: () => Keyring }) {
	const workspace = createWorkspace({
		id: HONEYCRISP_ID,
		keyring: opts.keyring,
		tables: honeycrispTables,
		kv: {},
	});
	const actions = createHoneycrispActions(workspace);
	const noteBodyDocs = createDisposableCache((noteId: NoteId) => {
		const childYdoc = new Y.Doc({
			guid: noteBodyDocGuid(noteId),
			gc: true,
		});
		const body = attachRichText(childYdoc);

		onLocalUpdate(childYdoc, () => {
			workspace.tables.notes.update(noteId, {
				updatedAt: DateTimeString.now(),
			});
		});

		return {
			ydoc: childYdoc,
			body,
			[Symbol.dispose]() {
				childYdoc.destroy();
			},
		};
	});

	return defineWorkspace({
		...workspace,
		actions,
		noteBodyDocs,
		[Symbol.dispose]() {
			noteBodyDocs[Symbol.dispose]();
			workspace[Symbol.dispose]();
		},
	});
}
export type HoneycrispWorkspace = ReturnType<typeof createHoneycrispWorkspace>;

/**
 * Deterministic guid of a note's rich-text body sub-doc.
 *
 * Browser editors, daemon materializers, and wipe paths reach this same
 * function so every layer points at the same Y.Doc identity.
 */
export function noteBodyDocGuid(noteId: NoteId): string {
	return docGuid({
		workspaceId: HONEYCRISP_ID,
		collection: 'notes',
		rowId: noteId,
		field: 'body',
	});
}

// ─── Actions ──────────────────────────────────────────────────────────────────

/**
 * Cross-table mutations layered on workspace tables.
 *
 * Includes operations that touch multiple tables in a single logical action
 * (e.g. folder deletion with note re-parenting). Simple single-table CRUD
 * stays in the Svelte state files.
 */
export function createHoneycrispActions(workspace: HoneycrispActionHost) {
	const { tables } = workspace;
	return defineActions({
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
					.getAllValid()
					.filter((n) => n.folderId === folderId);
				for (const note of folderNotes) {
					tables.notes.update(note.id, { folderId: null });
				}
				tables.folders.delete(folderId);
			},
		}),
	});
}
export type HoneycrispActions = ReturnType<typeof createHoneycrispActions>;
