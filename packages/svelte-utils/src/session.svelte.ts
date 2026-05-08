/**
 * Shared session state machine for apps that gate UI on a signed-in identity
 * plus an app-defined payload (typically a workspace handle).
 *
 * Status comes directly from `auth.state`; this factory only owns the payload
 * lifecycle (build, dispose) and the user-switch refusal (different `user.id`
 * disposes the payload and reloads the page). Same-user identity changes
 * (token refresh, key rotation, profile edits) are no-ops at the session
 * boundary. Lazy callbacks read `auth.state` at their own boundaries.
 *
 * Lazy callbacks (e.g., `bearerToken`, `encryptionKeys`) are read at:
 *   - attachment time (e.g., `attachEncryption` reads `encryptionKeys()` once
 *     per store registration to derive that store's keyring)
 *   - connection boundaries (sync's `bearerToken` is read at each sync
 *     connection attempt)
 *
 * They are NOT read by already-attached encrypted stores. Same-user key
 * rotation does not propagate to stores whose keyring was derived at an
 * earlier registration; re-attach the store to derive a new keyring.
 *
 * `current` projects `auth.state` and decorates the signed-in variant with the
 * built payload, so apps consume one read API and TypeScript narrows in one
 * step.
 *
 * Requires an `AuthClient` whose `state` is Svelte-reactive (use
 * `@epicenter/auth-svelte`, not `@epicenter/auth` directly).
 *
 * Per-machine vs per-user identity: peer-like values (installation id,
 * device name, platform) are per-machine. When peer identity is sync,
 * construct it inside `build` so browser storage is read when the
 * signed-in payload is built, and so TypeScript can contextually type the
 * object at the workspace open call. User identity (userId, encryption
 * keys, bearer token) is per-user and comes from the `identity` argument
 * or the auth client.
 *
 * If peer resolution is async (chrome.storage, etc.), resolve it before
 * calling `createSession` and capture the resolved value in the `build`
 * closure. The build factory itself stays sync.
 *
 * The factory only requires `userId` (for the same-user no-op vs.
 * different-user reload decision) and `Symbol.dispose` (for teardown).
 * Anything else on the payload is app shape, not session contract: callers
 * inject what consumers (e.g., `PersistenceGate`) need at the call site
 * rather than widening this constraint.
 *
 * @example
 * ```ts
 * export const session = createSession({
 *   auth,
 *   build: (identity) => {
 *     const fuji = openFuji({
 *       userId: identity.user.id,
 *       peer: {
 *         id: getOrCreateInstallationId(localStorage),
 *         name: 'Fuji',
 *         platform: 'web',
 *       },
 *       ...
 *     });
 *     return {
 *       userId: identity.user.id,
 *       fuji,
 *       [Symbol.dispose]() { fuji[Symbol.dispose](); },
 *     };
 *   },
 * });
 * export type FujiSignedIn = InferSignedIn<typeof session>;
 * ```
 */

import type { AuthClient, AuthIdentity, AuthState } from '@epicenter/auth';

export type Session<TSignedIn> =
	| Exclude<AuthState, { status: 'signed-in' }>
	| { status: 'signed-in'; signedIn: TSignedIn };

/**
 * Infer the signed-in payload type from a session created by `createSession`.
 *
 * Lets per-app modules define the SignedIn shape in one place (the build
 * factory) and derive the exported type from it, rather than declaring the
 * type up front and matching it inside the factory.
 *
 * @example
 * ```ts
 * export const session = createSession({ auth, build: (identity) => {...} });
 * export type FujiSignedIn = InferSignedIn<typeof session>;
 * ```
 */
export type InferSignedIn<TSession extends { current: unknown }> =
	TSession['current'] extends infer C
		? C extends { status: 'signed-in'; signedIn: infer T }
			? T
			: never
		: never;

export function createSession<
	TSignedIn extends { userId: string } & Disposable,
>({
	auth,
	build,
}: {
	auth: AuthClient;
	build: (identity: AuthIdentity) => TSignedIn;
}) {
	let signedIn = $state<TSignedIn | undefined>(undefined);

	function reconcile(state: AuthState) {
		if (state.status !== 'signed-in') {
			if (signedIn) {
				signedIn[Symbol.dispose]();
				signedIn = undefined;
			}
			return;
		}
		if (!signedIn) {
			signedIn = build(state.identity);
			return;
		}
		// Same user: no-op. Auth-bound callbacks read at their own boundaries:
		// sync can see refreshed tokens on connection attempts, while encrypted
		// stores keep the keyring they derived when they were attached.
		if (signedIn.userId === state.identity.user.id) return;
		// Different user: refuse the live switch and reload (heap safety).
		signedIn[Symbol.dispose]();
		location.reload();
		throw new Error('unreachable: reload pending');
	}

	const unsubscribe = auth.onStateChange(reconcile);
	// Initial replay: auth may have already settled before subscribe ran.
	reconcile(auth.state);

	return {
		get current(): Session<TSignedIn> {
			if (auth.state.status === 'pending') return { status: 'pending' };
			if (auth.state.status === 'signed-out') return { status: 'signed-out' };
			// Invariant: reconcile runs synchronously inside onStateChange, so
			// `signedIn` is always set when auth is signed-in. Defensive fallback
			// keeps the type honest without an `!`.
			if (!signedIn) return { status: 'pending' };
			return { status: 'signed-in', signedIn };
		},
		[Symbol.dispose]() {
			unsubscribe();
			signedIn?.[Symbol.dispose]();
		},
	};
}
