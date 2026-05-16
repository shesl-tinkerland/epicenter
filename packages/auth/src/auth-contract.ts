import type { Result } from 'wellcrafted/result';
import type { AuthError } from './auth-errors.js';
import type { SubjectIdentity } from './auth-types.js';

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
			localIdentity: SubjectIdentity;
	  }
	| {
			status: 'reauth-required';
			/**
			 * Local-first workspace identity cached on this device.
			 *
			 * Reauth is required for server access, but local workspace data can still
			 * open with this owner label and keyring.
			 */
			localIdentity: SubjectIdentity;
	  };

export type AuthClient = {
	state: AuthState;
	onStateChange(fn: (state: AuthState) => void): () => void;
	startSignIn(): Promise<Result<undefined, AuthError>>;
	signOut(): Promise<Result<undefined, AuthError>>;
	fetch(input: Request | string | URL, init?: RequestInit): Promise<Response>;
	openWebSocket(url: string | URL, protocols?: string[]): Promise<WebSocket>;
	[Symbol.dispose](): void;
};
