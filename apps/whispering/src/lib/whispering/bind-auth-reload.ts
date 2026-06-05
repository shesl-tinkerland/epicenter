/**
 * The reload half of Option A (sync singleton + reload).
 *
 * `openActiveWhispering` picks the doc once at boot; this rebuilds it on an
 * identity change by reloading the page, so the ~70 `whispering` importers never
 * see a swapping doc. Pairs with `whispering.active.ts`.
 */

import type { AuthState, SyncAuthClient } from '@epicenter/auth';

/**
 * Identity boundary key: `null` when signed out, otherwise the owner id. Token
 * expiry stays `signed-in`/`reauth-required` with the SAME `ownerId`, so the key
 * is unchanged and no reload fires; `openCollaboration` reconnects internally.
 */
function identityKey(state: AuthState) {
	return state.status === 'signed-out' ? null : state.ownerId;
}

/**
 * Reload the page when the signed-in owner identity changes (sign in / out /
 * switch account), so the next boot rebuilds the right doc. The boot identity is
 * captured once; the one-shot `reloading` guard collapses the
 * `signed-out` -> `signed-in:owner` pair an account switch emits into a single
 * reload. Returns the unsubscribe.
 *
 * Recorder safety lives at the source: the account controls are disabled while a
 * recording is in progress, so a reload can never interrupt an in-flight capture
 * (the browser `MediaRecorder` cannot survive a reload).
 */
export function bindAuthReload(auth: SyncAuthClient) {
	const bootKey = identityKey(auth.state);
	let reloading = false;
	return auth.onStateChange((state) => {
		if (reloading) return;
		if (identityKey(state) === bootKey) return;
		reloading = true;
		window.location.reload();
	});
}
