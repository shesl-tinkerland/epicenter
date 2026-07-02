/**
 * Boot-time Whispering client for both platforms (Option A: sync singleton +
 * reload).
 *
 * `connectLocalFirst` (`@epicenter/svelte/auth`, ADR-0088) reads the persisted
 * `auth.state` ONCE at startup and wires either the plaintext local doc
 * (signed out) or the owner doc with relay sync (signed in / reauth-required).
 * Construction is synchronous; data still loads async behind `whenReady`.
 * Identity changes are never an in-place swap: `reloadOnOwnerChange` (same
 * subpath, mounted in the root layout) reloads the page so the next boot
 * re-runs this selection.
 *
 * `openWhispering` wraps that doc with the one action every platform needs
 * (`recordings_export_markdown` — the logic is identical on both, see
 * `recordings-markdown-export.ts`) and exports the `satisfiesWorkspace`
 * shape. The two platform leaves (`whispering.browser.ts`,
 * `whispering.tauri.ts`) call this with only their default transcription
 * service; the `#platform/whispering` seam still needs two files so the
 * bundler picks the right one, but the two are otherwise identical.
 */

import { connectLocalFirst } from '@epicenter/svelte/auth';
import {
	createNodeId,
	defineActions,
	satisfiesWorkspace,
} from '@epicenter/workspace';
import { auth } from '#platform/auth';
import type { TranscriptionServiceId } from '$lib/services/transcription/providers';
import { createWhispering } from '$lib/workspace';
import { defineRecordingsMarkdownExport } from './recordings-markdown-export';

/**
 * Stable per-node id for relay room addressing, read synchronously from
 * `localStorage` (the async variant is only for the extension's
 * `chrome.storage`). Shared across Epicenter apps on this origin.
 */
const nodeId = createNodeId({ storage: window.localStorage });

/** Build the `whispering` singleton: the active doc plus the shared recordings-export action. */
export function openWhispering(
	defaultTranscriptionService: TranscriptionServiceId,
) {
	const workspace = createWhispering({ defaultTranscriptionService });
	const { whenReady, collaboration } = connectLocalFirst({
		auth,
		ydoc: workspace.ydoc,
		nodeId,
		actions: workspace.actions,
	});
	return satisfiesWorkspace({
		...workspace,
		actions: defineActions({
			...workspace.actions,
			recordings_export_markdown: defineRecordingsMarkdownExport(
				workspace.tables.recordings,
			),
		}),
		whenReady,
		collaboration,
	});
}
