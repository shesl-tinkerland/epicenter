/**
 * Reactive view state for Honeycrisp, backed by URL search params.
 *
 * Manages navigation, selection, search, sort, and view mode. Cross-cutting
 * derivations (filteredNotes, folderName, selectedNote) live here because
 * they combine data from multiple domains.
 *
 * State lives in the URL so it's bookmarkable, shareable, and works with
 * browser back/forward. Default values are elided from the URL to keep it
 * clean—`/` means all defaults (all notes, sorted by date edited, no search).
 *
 * @example
 * ```svelte
 * <script>
 *   import { viewState } from '../state';
 * </script>
 *
 * {#each viewState.filteredNotes as note (note.id)}
 *   <p>{note.title}</p>
 * {/each}
 * <p>Current folder: {viewState.folderName}</p>
 * ```
 */

import { searchParams, type SortBy } from '../search-params.svelte';
import type { FolderId, NoteId } from '../honeycrisp/workspace';
import type { createFoldersState } from './folders.svelte';
import type { createNotesState } from './notes.svelte';

export function createViewState({
	foldersState,
	notesState,
}: {
	foldersState: ReturnType<typeof createFoldersState>;
	notesState: ReturnType<typeof createNotesState>;
}) {
	// ─── Derived State ───────────────────────────────────────────────────

	/** Notes filtered by selected folder and search query, then sorted. */
	const filteredNotes = $derived.by(() => {
		const folderId = searchParams.folder;
		const q = searchParams.q.trim().toLowerCase();
		const sort = searchParams.sort;

		return notesState.notes
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

	/** Human-readable name for the current folder (used as NoteList title). */
	const folderName = $derived.by(() => {
		const folderId = searchParams.folder;
		return folderId
			? (foldersState.get(folderId)?.name ?? 'Notes')
			: 'All Notes';
	});

	/** The currently selected note (can be active or deleted). */
	const selectedNote = $derived.by(() => {
		const noteId = searchParams.note;
		return noteId ? (notesState.get(noteId) ?? null) : null;
	});

	// ─── Public API ──────────────────────────────────────────────────────

	return {
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
		get folderName() {
			return folderName;
		},
		get filteredNotes() {
			return filteredNotes;
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
		 * viewState.selectFolder(folderId);
		 *
		 * // Show all notes
		 * viewState.selectFolder(null);
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
		 * viewState.selectRecentlyDeleted();
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
		 * viewState.selectNote(noteId);
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
		 * viewState.setSortBy('title');
		 * viewState.setSortBy('dateEdited');
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
		 * viewState.setSearchQuery('meeting');
		 * viewState.setSearchQuery(''); // clear
		 * ```
		 */
		setSearchQuery(query: string) {
			searchParams.update({ q: query });
		},
	};
}
