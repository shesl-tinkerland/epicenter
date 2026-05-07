/**
 * Reactive folder state for Honeycrisp.
 *
 * Manages folder CRUD operations and the reactive folder list. Backed by
 * a Y.Doc CRDT table, so folders sync across devices. Clears URL search
 * param selections when the active folder is deleted.
 *
 * @example
 * ```svelte
 * <script>
 *   import { getSignedInSession } from '$lib/session.svelte';
 *
 *   const { foldersState } = getSignedInSession().state;
 * </script>
 *
 * {#each foldersState.folders as folder (folder.id)}
 *   <p>{folder.name}</p>
 * {/each}
 * <button onclick={() => foldersState.createFolder()}>New Folder</button>
 * ```
 */

import { fromTable } from '@epicenter/svelte';
import { generateId } from '@epicenter/workspace';
import type { Honeycrisp } from '../honeycrisp/browser';
import type { FolderId } from '../honeycrisp/workspace';
import { searchParams } from './search-params.svelte';

export function createFoldersState(honeycrisp: Honeycrisp) {
	// ─── Reactive State ──────────────────────────────────────────────────

	const foldersView = fromTable(honeycrisp.tables.folders);

	const folders = $derived(foldersView.all);

	// ─── Public API ──────────────────────────────────────────────────────

	return {
		/**
		 * Look up a folder by ID. Returns `undefined` if not found.
		 */
		byId(id: FolderId) {
			return foldersView.byId(id);
		},

		get folders() {
			return folders;
		},

		/**
		 * Create a new folder with the default name "New Folder".
		 *
		 * The folder is added to the end of the folder list and can be renamed
		 * immediately. Use this when the user clicks "New Folder" in the sidebar.
		 *
		 * @example
		 * ```typescript
		 * foldersState.createFolder();
		 * // Folder appears in sidebar with name "New Folder"
		 * ```
		 */
		createFolder() {
			const id = generateId() as FolderId;
			honeycrisp.tables.folders.set({
				id,
				name: 'New Folder',
				sortOrder: foldersView.all.length,
				_v: 1,
			});
		},

		/**
		 * Rename an existing folder.
		 *
		 * Updates the folder name in the sidebar and all references. The folder
		 * must exist; if it doesn't, the update is silently ignored.
		 *
		 * @example
		 * ```typescript
		 * foldersState.renameFolder(folderId, 'Work');
		 * ```
		 */
		renameFolder(folderId: FolderId, name: string) {
			honeycrisp.tables.folders.update(folderId, { name });
		},

		/**
		 * Delete a folder and move all its notes to unfiled.
		 *
		 * The folder is removed from the sidebar. All notes that were in this
		 * folder are moved to the unfiled section (folderId set to undefined).
		 * If the deleted folder was selected, the folder and note selections are cleared.
		 *
		 * @example
		 * ```typescript
		 * foldersState.deleteFolder(folderId);
		 * // Folder disappears from sidebar, its notes move to "All Notes"
		 * ```
		 */
		deleteFolder(folderId: FolderId) {
			honeycrisp.actions.folders.delete({ folderId });
			if (searchParams.folder === folderId) {
				searchParams.update({ folder: null, note: null });
			}
		},
	};
}
