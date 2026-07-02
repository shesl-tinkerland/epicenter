/**
 * The reload half of the one composition shape (sync singleton + reload,
 * ADR-0088).
 *
 * `connectLocalFirst` picks the doc once at boot from `auth.state`; this
 * reloads the page when the owner identity later changes, so the next boot
 * rebuilds the right doc and the app's importers never see a swapping doc.
 *
 * The name says "reload" out loud on purpose: this is a deliberate full-page
 * restart, the settled tradeoff (a live in-place doc swap would be a
 * many-file migration with leaked-observer risk), not soft plumbing.
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
 * account). Returns the unsubscribe. Mount once in the app's root layout.
 *
 * The boot key is read here at mount rather than threaded from the boot doc
 * selection, and the two agree: the owner cannot change between module load
 * and first mount (sign-in/out need a user round-trip). The one-shot
 * `reloading` guard collapses the `signed-out` -> `signed-in:owner` pair an
 * account switch emits into a single reload.
 *
 * Reload safety lives at the source: a host with an unsafe-to-interrupt
 * moment (e.g. an in-flight recording) disables the account controls via
 * `AccountPopover`'s `disabledReason`, so a reload can never fire mid-action.
 *
 * @param options.callbackPath - The app's OAuth callback route. A sign-in
 * completing there fires this state change before the page's own redirect can
 * run; a bare reload would land back on the callback URL and replay the
 * already-consumed authorization code, surfacing a spurious error after a
 * real success, so that one location gets `replace('/')` instead.
 */
export function reloadOnOwnerChange(
	auth: SyncAuthClient,
	{ callbackPath = '/auth/callback' }: { callbackPath?: string } = {},
) {
	const bootKey = ownerKey(auth.state);
	let reloading = false;
	return auth.onStateChange((state) => {
		if (reloading) return;
		if (ownerKey(state) === bootKey) return;
		reloading = true;
		if (window.location.pathname === callbackPath) {
			window.location.replace('/');
			return;
		}
		window.location.reload();
	});
}
