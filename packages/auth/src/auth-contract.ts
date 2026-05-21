import type { Result } from 'wellcrafted/result';
import type { AuthError } from './auth-errors.js';
import type { LocalIdentity } from './auth-types.js';

/**
 * Current auth state for local-first workspace clients.
 *
 * `localIdentity` is present in `signed-in` and `reauth-required` because it is
 * the part of auth that belongs to local workspace operations. Even when the
 * OAuth grant needs reauth, the cached local identity can still choose the
 * right local owner and decrypt local workspace data.
 *
 * Auth state carries capability material only. Profile data is fetched by
 * application surfaces that display it.
 */
export type AuthState =
	| { status: 'signed-out' }
	| {
			status: 'signed-in';
			/**
			 * Local-first workspace identity cached on this device.
			 *
			 * Use this for workspace boot, local storage ownership, and decrypting
			 * local data. Do not treat it as the user's profile; account UI should
			 * fetch display data separately.
			 */
			localIdentity: LocalIdentity;
	  }
	| {
			status: 'reauth-required';
			/**
			 * Local-first workspace identity cached on this device.
			 *
			 * Reauth is required for server access, but local workspace data can still
			 * open with this owner label and keyring.
			 */
			localIdentity: LocalIdentity;
	  };

export type AuthClient = {
	state: AuthState;
	/**
	 * Subscribe to future state changes.
	 *
	 * Read `state` once before registering when bootstrap state matters. The
	 * listener does not replay the current state, which keeps subscriptions from
	 * accidentally duplicating synchronous boot logic.
	 */
	onStateChange(fn: (state: AuthState) => void): () => void;
	/**
	 * Start the runtime's sign-in flow.
	 *
	 * Use this from UI or CLI commands that can hand control to the configured
	 * launcher. Completion means the launcher finished its work, not that a page
	 * navigation happened; callers should observe `state` for the durable signed
	 * in signal.
	 */
	startSignIn(): Promise<Result<undefined, AuthError>>;
	/**
	 * Clear local auth and revoke the refresh token when the server is reachable.
	 *
	 * Use this for explicit user logout. The local persisted cell is removed
	 * first, so local workspace access stops depending on whether the best-effort
	 * revoke request succeeds.
	 */
	signOut(): Promise<Result<undefined, AuthError>>;
	/**
	 * Fetch an API resource through the auth-owned bearer boundary.
	 *
	 * Use this instead of reading tokens from storage. The client verifies
	 * `/api/session` before attaching a bearer, refreshes on expiry or 401, and
	 * omits browser cookies so OAuth tokens remain the resource credential.
	 */
	fetch(input: Request | string | URL, init?: RequestInit): Promise<Response>;
	/**
	 * Open a WebSocket using the same bearer boundary as `fetch`.
	 *
	 * Browsers cannot set `Authorization` on WebSocket upgrades, so the token is
	 * carried as an Epicenter bearer subprotocol and normalized by the API before
	 * protected route code runs.
	 */
	openWebSocket(url: string | URL, protocols?: string[]): Promise<WebSocket>;
	[Symbol.dispose](): void;
};
