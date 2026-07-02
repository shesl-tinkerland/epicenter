/**
 * Boot-time Honeycrisp client (ADR-0088: sign-in is an enhancement, never a
 * door).
 *
 * `connectLocalFirst` (inside `openHoneycrispBrowser`, see
 * `$lib/workspace/browser.ts`) reads the persisted `auth.state` ONCE at
 * startup and wires either bare local IndexedDB (signed out) or owner-scoped
 * storage plus relay sync (signed in / reauth-required). Construction is
 * synchronous; data still loads async behind `whenReady`. Identity changes
 * are never an in-place swap: `reloadOnOwnerChange` (mounted in the root
 * layout) reloads the page so the next boot re-runs this selection.
 *
 * `honeycrisp` composes that browser bundle with `createHoneycrispState`, the
 * app's reactive folder/note/view state. There is no `require*()` accessor
 * and no HMR dispose block: the workspace is never `null`, so nothing gates
 * on it existing (matches Whispering's `whispering` singleton).
 */

import { createNodeId } from '@epicenter/workspace';
import { auth } from '#platform/auth';
import { createHoneycrispState } from '../routes/state';
import { openHoneycrispBrowser } from './workspace/browser';

const nodeId = createNodeId({ storage: localStorage });

const browser = openHoneycrispBrowser({ auth, nodeId });
const state = createHoneycrispState(browser);

export const honeycrisp = {
	...browser,
	state,
};
