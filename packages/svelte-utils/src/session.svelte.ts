import type { AuthClient, AuthState } from '@epicenter/auth';
import { createLocalOwner, type LocalOwner } from '@epicenter/workspace';

/**
 * Auth-gated payload built once per identity-bearing auth state and disposed
 * on sign-out. `reauth-required` keeps the existing payload mounted: OAuth
 * sessions are single-subject by structure, so two consecutive identity-bearing
 * states are always the same subject.
 *
 * The build callback receives a `LocalOwner` (`@epicenter/workspace`) that
 * carries `subject` plus a lazy `keyring()` reader. The reader pulls from
 * the live `state.localIdentity` so refreshed keyrings (after `/api/me`
 * rotates them) are picked up on next access without rebuilding the payload.
 *
 * Requires an `AuthClient` whose `state` is Svelte-reactive (use
 * `@epicenter/auth-svelte`, not `@epicenter/auth` directly).
 */
export function createSession<T extends Disposable>({
	auth,
	build,
}: {
	auth: AuthClient;
	build: (context: { owner: LocalOwner }) => T;
}) {
	let payload = $state<T | null>(null);

	function reconcile(state: AuthState) {
		if (state.status === 'signed-out') {
			payload?.[Symbol.dispose]();
			payload = null;
			return;
		}
		if (payload) return;
		payload = build({
			owner: createLocalOwner({
				subject: state.localIdentity.subject,
				keyring: () => {
					if (auth.state.status === 'signed-out') {
						throw new Error(
							'[session] keyring() called while signed-out.',
						);
					}
					return auth.state.localIdentity.keyring;
				},
			}),
		});
	}

	const unsubscribe = auth.onStateChange(reconcile);
	reconcile(auth.state);

	return {
		get current(): T | null {
			return payload;
		},
		require(): T {
			if (!payload) {
				throw new Error('[session] require() called while signed-out.');
			}
			return payload;
		},
		[Symbol.dispose]() {
			unsubscribe();
			payload?.[Symbol.dispose]();
			payload = null;
		},
	};
}
