/**
 * Reactive saved tab state for the side panel.
 *
 * Read-only reactive layer backed by `fromTable()` — provides granular
 * per-row reactivity via `SvelteMap`. All write operations are delegated
 * to workspace actions defined in `client.ts`.
 *
 * The public API exposes a `$derived` sorted array since the access
 * pattern is always "render the full sorted list."
 *
 * @example
 * ```svelte
 * <script>
 *   import { savedTabState } from '$lib/state/saved-tab-state.svelte';
 * </script>
 *
 * {#each savedTabState.tabs as tab (tab.id)}
 *   <SavedTabItem {tab} />
 * {/each}
 *
 * <button onclick={() => savedTabState.restoreAll()}>
 *   Restore all
 * </button>
 * ```
 */

import { fromTable } from '@epicenter/svelte';
import { tabManager } from '$lib/tab-manager/client';
import type { BrowserTab } from '$lib/state/browser-state.svelte';
import type { SavedTab, SavedTabId } from '$lib/workspace';

function createSavedTabState() {
	const tabsMap = fromTable(tabManager.tables.savedTabs);

	/** All saved tabs, sorted by most recently saved first. Cached via $derived. */
	const tabs = $derived(
		[...tabsMap.values()]
			.sort((a, b) => b.savedAt - a.savedAt),
	);

	return {
		[Symbol.dispose]() {
			tabsMap[Symbol.dispose]();
		},

		get tabs() {
			return tabs;
		},

		/**
		 * Save a tab — snapshot its metadata to Y.Doc and close the browser tab.
		 *
		 * Delegates to the `savedTabs.save` workspace action. Silently no-ops
		 * for tabs without a URL. The action's Result envelope flows through
		 * to callers; today the action's Err channel is `never` because
		 * browser-API failures during the close step are intentionally
		 * swallowed inside the handler.
		 */
		async save(tab: BrowserTab) {
			if (!tab.url) return;
			return tabManager.actions.savedTabs.save({
				browserTabId: tab.id,
				url: tab.url,
				title: tab.title || 'Untitled',
				favIconUrl: tab.favIconUrl,
				pinned: tab.pinned,
			});
		},

		/**
		 * Restore a saved tab — re-open in browser and delete the record.
		 *
		 * The action returns `Result<{ restored }, BrowserApiFailed>` — the
		 * saved record is preserved on `tabs.create` failure so the user
		 * doesn't lose the URL.
		 */
		async restore(savedTab: SavedTab) {
			return tabManager.actions.savedTabs.restore({
				id: savedTab.id,
				url: savedTab.url,
				pinned: savedTab.pinned,
			});
		},

		/** Restore all saved tabs at once. */
		async restoreAll() {
			return tabManager.actions.savedTabs.restoreAll();
		},

		/** Delete a saved tab without restoring it. Synchronous CRDT delete. */
		remove(id: SavedTabId) {
			return tabManager.actions.savedTabs.remove({ id });
		},

		/** Delete all saved tabs without restoring them. Synchronous CRDT batch delete. */
		removeAll() {
			return tabManager.actions.savedTabs.removeAll();
		},
	};
}

export const savedTabState = createSavedTabState();

if (import.meta.hot) {
	import.meta.hot.dispose(() => savedTabState[Symbol.dispose]());
}
