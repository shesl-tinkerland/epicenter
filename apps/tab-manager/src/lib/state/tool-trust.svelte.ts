/**
 * Reactive tool trust state backed by the workspace's toolTrust table.
 *
 * The table is a presence set of auto-approved tool names: a row means
 * "always allow", no row means "ask" (the safe default), so revoking
 * deletes the row instead of writing a junk default. Mutation tools start
 * absent and show approval UI in chat; "Always Allow" adds the row and
 * future invocations auto-approve. Query tools never consult this module:
 * they auto-execute always.
 *
 * Trust state syncs across devices via the workspace's Y.Doc CRDT.
 *
 * @module
 */

import { fromTable } from '@epicenter/svelte';
import type { TabManagerBrowser } from '$lib/tab-manager/extension';

export type ToolTrustState = ReturnType<typeof createToolTrustState>;

export function createToolTrustState(tabManager: TabManagerBrowser) {
	const trustMap = fromTable(tabManager.tables.toolTrust);

	/** Cached projection of trusted tool names: stable reference via $derived. */
	const trustedNames = $derived([...trustMap.keys()]);

	return {
		[Symbol.dispose]() {
			trustMap[Symbol.dispose]();
		},

		/**
		 * Whether a tool auto-approves without showing the approval UI.
		 * Query tools should not call this because they auto-execute always.
		 */
		shouldAutoApprove(name: string): boolean {
			return trustMap.has(name);
		},

		/** Auto-approve this tool from now on (the "Always Allow" action). */
		allow(name: string): void {
			tabManager.tables.toolTrust.set({ id: name });
		},

		/** Return this tool to the ask-every-time default. */
		revoke(name: string): void {
			tabManager.tables.toolTrust.delete(name);
		},

		/** Names of all auto-approved tools, as a cached reactive array. */
		get trustedToolNames(): string[] {
			return trustedNames;
		},
	};
}
