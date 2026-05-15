import { SubjectKeyring } from '@epicenter/encryption';
import type { StandardSchemaV1 } from '@standard-schema/spec';
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

const CurrentPersistedAuth = type({
	'+': 'delete',
	grant: OAuthTokenGrant,
	localIdentity: LocalWorkspaceIdentity,
});

/**
 * Legacy persisted auth shape. Old browsers, extensions, and CLI files may
 * still hold `{ grant, unlock: { userId, encryptionKeys } }`. The migration
 * runs at storage parse time; once normalized, only the new shape is written
 * back. Public auth code never observes the legacy field names.
 */
const LegacyPersistedAuth = type({
	'+': 'delete',
	grant: OAuthTokenGrant,
	unlock: {
		'+': 'delete',
		userId: 'string',
		encryptionKeys: SubjectKeyring,
	},
});

export type PersistedAuth = typeof CurrentPersistedAuth.infer;

function migrateLegacy(
	legacy: typeof LegacyPersistedAuth.infer,
): PersistedAuth {
	return {
		grant: legacy.grant,
		localIdentity: {
			subject: legacy.unlock.userId,
			keyring: legacy.unlock.encryptionKeys,
		},
	};
}

/**
 * Try to parse a raw value as a current or legacy `PersistedAuth` cell.
 * Returns the canonical shape on success or `null` if neither shape matches.
 *
 * The legacy branch is only attempted when the current branch fails, so a
 * value containing both `localIdentity` and `unlock` resolves to the new
 * shape and the legacy `unlock` key is dropped by the current arktype's
 * `+: delete` directive.
 */
export function parsePersistedAuth(value: unknown): PersistedAuth | null {
	if (value === null || value === undefined) return null;
	const current = CurrentPersistedAuth(value);
	if (!(current instanceof type.errors)) return current as PersistedAuth;
	const legacy = LegacyPersistedAuth(value);
	if (!(legacy instanceof type.errors)) return migrateLegacy(legacy);
	return null;
}

/**
 * The single persisted auth cell. Two clearly-labeled sections.
 *
 * Browser persists to localStorage, extension to chrome.storage.local, CLI
 * to `~/.epicenter/auth.json` (mode 0o600). All three cells validate against
 * this Standard Schema. Profile data is intentionally absent; application
 * surfaces fetch it when they display it.
 *
 * Accepts and migrates the legacy `{ grant, unlock: { userId, encryptionKeys } }`
 * shape on read. Writes always emit the canonical
 * `{ grant, localIdentity: { subject, keyring } }` shape.
 */
export const PersistedAuth: StandardSchemaV1<unknown, PersistedAuth> & {
	assert(value: unknown): PersistedAuth;
	or(literal: 'null'): StandardSchemaV1<unknown, PersistedAuth | null>;
} = {
	'~standard': {
		version: 1,
		vendor: 'epicenter-auth',
		validate(value: unknown) {
			const parsed = parsePersistedAuth(value);
			if (parsed === null) {
				return {
					issues: [
						{ message: 'Value does not match PersistedAuth (current or legacy)' },
					],
				};
			}
			return { value: parsed };
		},
	},
	assert(value: unknown): PersistedAuth {
		const parsed = parsePersistedAuth(value);
		if (parsed === null) {
			throw new Error('Value does not match PersistedAuth (current or legacy)');
		}
		return parsed;
	},
	or(_literal: 'null'): StandardSchemaV1<unknown, PersistedAuth | null> {
		return {
			'~standard': {
				version: 1,
				vendor: 'epicenter-auth',
				validate(value: unknown) {
					if (value === null) return { value: null };
					const parsed = parsePersistedAuth(value);
					if (parsed === null) {
						return {
							issues: [
								{
									message:
										'Value does not match PersistedAuth | null (current or legacy)',
								},
							],
						};
					}
					return { value: parsed };
				},
			},
		};
	},
};
