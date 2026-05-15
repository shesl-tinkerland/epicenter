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
 * Device capability to decrypt local Yjs data without the server. Persisted
 * under `PersistedAuth.localIdentity`. `subject` is an opaque owner label
 * bound to the keyring; today it equals the Better Auth `user.id`, but the
 * persisted shape does not depend on that.
 */
export const LocalWorkspaceIdentity = type({
	'+': 'delete',
	subject: 'string',
	keyring: SubjectKeyring,
});

export type LocalWorkspaceIdentity = typeof LocalWorkspaceIdentity.infer;

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
	localIdentity: LocalWorkspaceIdentity,
});

export type PersistedAuth = typeof PersistedAuth.infer;
