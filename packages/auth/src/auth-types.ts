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
	accessTokenExpiresAt: 'number',
});

export type OAuthTokenGrant = typeof OAuthTokenGrant.infer;

/**
 * Local workspace identity returned by `/api/me` and cached on this device.
 *
 * `subject` is the server-issued identity label used to derive the subject
 * keyring. Today it is the Better Auth `user.id`. It is not a profile record,
 * email address, or display user. Future servers may choose a scoped value,
 * such as `issuer:userId` or `tenant:userId`, without changing this client
 * shape.
 *
 * Workspace code treats this same value as the owner id for browser-local Yjs
 * storage and BroadcastChannel names. In other words: auth names the keyed
 * identity `subject`; local persistence uses that subject as the owner.
 */
export const SubjectIdentity = type({
	'+': 'delete',
	subject: 'string',
	keyring: SubjectKeyring,
});

export type SubjectIdentity = typeof SubjectIdentity.infer;

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
	localIdentity: SubjectIdentity,
});

export type PersistedAuth = typeof PersistedAuth.infer;

/**
 * Canonical `/api/me` response shape. The single contract between the API
 * and every Epicenter auth client (browser, extension, CLI machine, daemon).
 *
 * `user` is the Better Auth profile slice displayed in account UI.
 * `localIdentity` is the offline-decrypt material the client persists into
 * `PersistedAuth.localIdentity`.
 */
export const ApiMeResponse = type({
	'+': 'delete',
	user: AuthUser,
	localIdentity: SubjectIdentity,
});

export type ApiMeResponse = typeof ApiMeResponse.infer;
