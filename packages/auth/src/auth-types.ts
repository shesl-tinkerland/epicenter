import { SubjectKeyring } from '@epicenter/encryption';
import { type } from 'arktype';

export const AuthUser = type({
	'+': 'delete',
	id: 'string',
	email: 'string',
});

export type AuthUser = typeof AuthUser.infer;

/**
 * OAuth token grant. Persisted under `PersistedAuth.grant`.
 *
 * Server-access material: required to call `/api/*` online; offline-useless
 * on its own. Refresh tokens rotate on every successful refresh.
 */
export const OAuthTokenGrant = type({
	'+': 'delete',
	accessToken: 'string',
	refreshToken: 'string',
	/**
	 * Absolute access-token expiry as epoch milliseconds.
	 *
	 * Computed from the OAuth `expires_in` seconds returned with the token
	 * grant (`accessTokenExpiresAt = now() + expires_in * 1000`). Used only as
	 * a transport refresh hint: the resource server is still the source of
	 * truth for token validity, so this value is checked locally to decide
	 * when to refresh, never to authorize a request.
	 */
	accessTokenExpiresAt: 'number',
});

export type OAuthTokenGrant = typeof OAuthTokenGrant.infer;

/**
 * Local-first workspace identity returned by `/api/session` and cached on this
 * device.
 *
 * This is the part of auth that belongs to local workspace operations. The app
 * keeps it so a signed-in workspace can still open offline, choose the right
 * local storage owner, and decrypt local data when the OAuth grant cannot be
 * refreshed yet.
 *
 * `subject` is the server-issued owner label for local data. Today it is the
 * Better Auth `user.id`. It is not a profile record, email address, or display
 * user. Future servers may choose an issuer-scoped value without changing this
 * client shape.
 *
 * Workspace code calls this same value `ownerId` once it is used to name
 * browser-local Yjs storage and BroadcastChannel channels. Auth names the value
 * by where it comes from: a server subject. Workspace names the value by what
 * it owns locally: workspace data.
 */
export const LocalIdentity = type({
	'+': 'delete',
	subject: 'string',
	keyring: SubjectKeyring,
});

export type LocalIdentity = typeof LocalIdentity.infer;

/**
 * The single persisted auth cell. Two clearly-labeled sections.
 *
 * Browser persists to localStorage, extension to chrome.storage.local, CLI
 * to `~/.epicenter/auth.json` (mode 0o600). All three cells validate against
 * this arktype, which satisfies StandardSchemaV1 natively via `~standard`,
 * so it plugs straight into Standard-Schema consumers like createPersistedState.
 * Profile data is intentionally absent; application surfaces fetch it when
 * they display it.
 */
export const PersistedAuth = type({
	'+': 'delete',
	grant: OAuthTokenGrant,
	/**
	 * Cached local-first workspace identity.
	 *
	 * This is persisted separately from the OAuth grant because it remains useful
	 * offline. The grant lets the app call the server; `localIdentity` lets the
	 * app select and decrypt this user's local workspace data.
	 */
	localIdentity: LocalIdentity,
});

export type PersistedAuth = typeof PersistedAuth.infer;

/**
 * Canonical `/api/session` response shape. The single contract between the
 * API and every Epicenter auth client (browser, extension, CLI machine,
 * daemon).
 *
 * `user` is the Better Auth profile slice displayed in account UI.
 * `localIdentity` is the local-first workspace identity: the owner label and
 * keyring used to open local workspace data, including while offline.
 */
export const ApiSessionResponse = type({
	'+': 'delete',
	user: AuthUser,
	/**
	 * Local-first workspace identity for this account.
	 *
	 * This is the part of auth that belongs to local workspace operations. It is
	 * cached into `PersistedAuth.localIdentity` so workspace boot and decryption
	 * do not depend on a live network request.
	 */
	localIdentity: LocalIdentity,
});

export type ApiSessionResponse = typeof ApiSessionResponse.infer;
