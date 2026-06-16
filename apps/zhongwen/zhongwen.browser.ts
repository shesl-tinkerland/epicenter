/**
 * Zhongwen browser composition.
 *
 * Single source of truth for "how Zhongwen mounts in a browser." Calls Tier 1
 * primitives through the shared workspace definition:
 *
 *  1. workspace root doc (tables + KV)
 *  2. local storage + cloud sync for root
 *  3. runtime storage + sync around the per-conversation transcript child docs
 *
 * The bundle's `wipe()` drops every owner-scoped IDB database;
 * `Symbol.dispose` tears down the root and cached child Y.Docs without
 * touching local storage.
 */

import type { SignedIn } from '@epicenter/svelte/auth';
import type { NodeId } from '@epicenter/workspace';
import { zhongwenWorkspace } from './zhongwen.js';

/**
 * Open Zhongwen in the browser with local storage, cloud sync, and the
 * per-conversation transcript doc cache.
 */
export function openZhongwenBrowser({
	signedIn,
	nodeId,
}: {
	signedIn: SignedIn;
	nodeId: NodeId;
}) {
	return zhongwenWorkspace.connect({ ...signedIn, nodeId });
}
