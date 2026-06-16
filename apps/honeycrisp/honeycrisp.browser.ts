/**
 * Honeycrisp browser composition.
 *
 * Single source of truth for "how Honeycrisp mounts in a browser." The shared
 * workspace definition owns root wiring and child-doc opening:
 *
 *  1. workspace root doc (tables + KV)
 *  2. local storage + cloud sync for root
 *  3. runtime storage + sync around per-note body child docs
 *
 * The bundle's `wipe()` drops every owner-scoped IDB database;
 * `Symbol.dispose` tears down the root and cached child Y.Docs without touching
 * local storage.
 */

import type { SignedIn } from '@epicenter/svelte/auth';
import type { NodeId } from '@epicenter/workspace';
import { honeycrispWorkspace } from './honeycrisp.js';

export function openHoneycrispBrowser({
	signedIn,
	nodeId,
}: {
	signedIn: SignedIn;
	nodeId: NodeId;
}) {
	return honeycrispWorkspace.connect({ ...signedIn, nodeId });
}

export type HoneycrispBrowser = ReturnType<typeof openHoneycrispBrowser>;
