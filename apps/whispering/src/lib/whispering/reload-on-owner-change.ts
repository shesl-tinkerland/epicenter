/**
 * The reload half of Option A (sync singleton + reload).
 *
 * `openActiveWhispering` picks the doc once at boot from `auth.state`; this
 * reloads the page when the owner identity later changes, so the next boot
 * rebuilds the right doc and the ~70 `whispering` importers never see a swapping
 * doc. Pairs with `whispering.active.ts`.
 *
 * The name says "reload" out loud on purpose: this is a deliberate full-page
 * restart, the settled Option A tradeoff (a live in-place doc swap would be a
 * ~70-file migration with leaked-observer risk), not soft plumbing.
 */

import type { AuthState, SyncAuthClient } from '@epicenter/auth';

/**
 * The owner boundary: `null` when signed out, otherwise the owner id. Token
 * expiry stays `signed-in`/`reauth-required` with the SAME `ownerId`, so the key
 * is unchanged and no reload fires; `openCollaboration` reconnects internally.
 */
function ownerKey(state: AuthState) {
	return state.status === 'signed-out' ? null : state.ownerId;
}

/**
 * Reload the page when the owner identity changes (sign in / out / switch
 * account). Returns the unsubscribe.
 *
 * The boot key is read here at mount rather than threaded from
 * `openActiveWhispering`'s pick, and the two agree: the owner cannot change
 * between module load and first mount (sign-in/out need a user round-trip), and
 * the only state that CAN move in that window is `networkAccess`, which does not
 * affect `ownerKey`. The one-shot `reloading` guard collapses the `signed-out`
 * -> `signed-in:owner` pair an account switch emits into a single reload.
 *
 * Recorder safety lives at the source: the account controls are disabled while a
 * recording is in progress, so a reload can never interrupt an in-flight capture
 * (the browser `MediaRecorder` cannot survive a reload).
 */
export function reloadOnOwnerChange(auth: SyncAuthClient) {
	const bootKey = ownerKey(auth.state);
	let reloading = false;
	return auth.onStateChange((state) => {
		if (reloading) return;
		if (ownerKey(state) === bootKey) return;
		reloading = true;
		window.location.reload();
	});
}
