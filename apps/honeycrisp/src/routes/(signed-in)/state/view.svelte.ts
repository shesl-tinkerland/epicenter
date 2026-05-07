/**
 * Reactive view state for Honeycrisp, backed by URL search params.
 *
 * The lens the user is currently looking through. Owns navigation,
 * selection, search, sort, view mode, and the derived "what notes does
 * the user see right now" question (`currentNotes` plus its title and
 * empty-state messaging).
 *
 * State lives in the URL so it's bookmarkable, shareable, and works with
 * browser back/forward. Default values are elided from the URL to keep it
 * clean: `/` means all defaults (all notes, sorted by date edited, no search).
 *
 * @example
 * ```svelte
 * <script>
 *   import { getSignedInSession } from '$lib/session.svelte';
 *
 *   const signedIn = getSignedInSession();
 * </script>
 *
 * {#each signedIn.state.view.currentNotes as note (note.id)}
 *   <p>{note.title}</p>
 * {/each}
 * <p>Current title: {signedIn.state.view.currentTitle}</p>
 * ```
 */

import type { FolderId, NoteId } from '../honeycrisp/workspace';
import type { createFolders } from './folders.svelte';
import type { createNotes } from './notes.svelte';
import { type SortBy, searchParams } from './search-params.svelte';

export function createView({
	folders,
	notes,
}: {
	folders: ReturnType<typeof createFolders>;
	notes: ReturnType<typeof createNotes>;
}) {
	// ─── Derived State ───────────────────────────────────────────────────

	/** Notes filtered by selected folder and search query, then sorted. */
	const filteredNotes = $derived.by(() => {
		const folderId = searchParams.folder;
		const q = searchParams.q.trim().toLowerCase();
		const sort = searchParams.sort;

		return notes.all
			.filter((n) => folderId === null || n.folderId === folderId)
			.filter(
				(n) =>
					!q ||
					n.title.toLowerCase().includes(q) ||
					n.preview.toLowerCase().includes(q),
			)
			.toSorted((a, b) => {
				if (sort === 'title') return a.title.localeCompare(b.title);
				if (sort === 'dateCreated')
					return b.createdAt.localeCompare(a.createdAt);
				return b.updatedAt.localeCompare(a.updatedAt);
			});
	});

	/** Human-readable name for the current folder. Feeds `currentTitle`. */
	const folderName = $derived.by(() => {
		const folderId = searchParams.folder;
		return folderId ? (folders.get(folderId)?.name ?? 'Notes') : 'All Notes';
	});

	/** The currently selected note (can be active or deleted). */
	const selectedNote = $derived.by(() => {
		const noteId = searchParams.note;
		return noteId ? (notes.get(noteId) ?? null) : null;
	});

	// ─── Public API ──────────────────────────────────────────────────────

	return {
		[Symbol.dispose]() {},
		get selectedFolderId(): FolderId | null {
			return searchParams.folder;
		},
		get selectedNoteId(): NoteId | null {
			return searchParams.note;
		},
		get selectedNote() {
			return selectedNote;
		},
		get searchQuery() {
			return searchParams.q;
		},
		get sortBy(): SortBy {
			return searchParams.sort;
		},
		get isRecentlyDeletedView() {
			return searchParams.isDeletedView;
		},

		/**
		 * The list of notes the user currently sees: deleted notes when in
		 * Recently Deleted, otherwise the folder/search-filtered + sorted list.
		 */
		get currentNotes() {
			return searchParams.isDeletedView ? notes.deleted : filteredNotes;
		},
		/** The header title for the current notes list. */
		get currentTitle(): string {
			return searchParams.isDeletedView ? 'Recently Deleted' : folderName;
		},
		/** Whether the sort + new-note controls should appear. Off in Recently Deleted. */
		get currentShowControls(): boolean {
			return !searchParams.isDeletedView;
		},
		/** The empty-state message for the current notes list. */
		get currentEmptyMessage(): string {
			return searchParams.isDeletedView
				? 'No deleted notes'
				: 'No notes yet. Click + to create one.';
		},

		/**
		 * Select a folder and clear the note selection.
		 *
		 * Switches the view to show notes in the selected folder. If `null` is
		 * passed, shows all notes (unfiled + all folders). Also clears the
		 * Recently Deleted view if it was active.
		 *
		 * @example
		 * ```typescript
		 * signedIn.state.view.selectFolder(folderId);
		 *
		 * // Show all notes
		 * signedIn.state.view.selectFolder(null);
		 * ```
		 */
		selectFolder(folderId: FolderId | null) {
			searchParams.update({ view: null, note: null, folder: folderId });
		},

		/**
		 * Switch to the Recently Deleted view.
		 *
		 * Shows only soft-deleted notes. Clears the folder selection and note
		 * selection.
		 *
		 * @example
		 * ```typescript
		 * signedIn.state.view.selectRecentlyDeleted();
		 * ```
		 */
		selectRecentlyDeleted() {
			searchParams.update({ folder: null, note: null, view: 'deleted' });
		},

		/**
		 * Select a note by ID to open it in the editor.
		 *
		 * @example
		 * ```typescript
		 * signedIn.state.view.selectNote(noteId);
		 * ```
		 */
		selectNote(noteId: NoteId) {
			searchParams.update({ note: noteId });
		},

		/**
		 * Change the note sort order.
		 *
		 * Sorts the note list by the specified criteria. The default
		 * ('dateEdited') is elided from the URL to keep it clean.
		 *
		 * @example
		 * ```typescript
		 * signedIn.state.view.setSortBy('title');
		 * signedIn.state.view.setSortBy('dateEdited');
		 * ```
		 */
		setSortBy(value: SortBy) {
			searchParams.update({ sort: value });
		},

		/**
		 * Update the search filter text.
		 *
		 * Filters the note list to show only notes whose title or preview
		 * contains the search query (case-insensitive). Pass an empty string
		 * to clear the search.
		 *
		 * @example
		 * ```typescript
		 * signedIn.state.view.setSearchQuery('meeting');
		 * signedIn.state.view.setSearchQuery(''); // clear
		 * ```
		 */
		setSearchQuery(query: string) {
			searchParams.update({ q: query });
		},
	};
}
