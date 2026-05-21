import type { SchemaClient } from '@better-auth/oauth-provider';
import {
	EPICENTER_OAUTH_SCOPES,
	EPICENTER_TRUSTED_OAUTH_CLIENTS,
} from '@epicenter/constants/oauth';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '../db/schema';

let trustedOAuthClientsSeed: Promise<void> | null = null;

type TrustedOAuthClientInput = {
	[K in 'clientId' | 'name']-?: NonNullable<SchemaClient[K]>;
} & {
	type: Extract<
		NonNullable<SchemaClient['type']>,
		'native' | 'user-agent-based'
	>;
	redirectUris: readonly string[];
};

const TRUSTED_OAUTH_CLIENT_POLICY = {
	disabled: false,
	skipConsent: true,
	tokenEndpointAuthMethod: 'none',
	grantTypes: ['authorization_code'],
	responseTypes: ['code'],
	public: true,
	requirePKCE: true,
} satisfies Required<
	Pick<
		SchemaClient,
		| 'disabled'
		| 'skipConsent'
		| 'tokenEndpointAuthMethod'
		| 'grantTypes'
		| 'responseTypes'
		| 'public'
		| 'requirePKCE'
	>
>;

/**
 * Project a checked-in trusted client definition into Better Auth's client row.
 *
 * Use this for seeding and tests that need the exact database representation.
 * It preserves the trusted-client invariant: first-party apps are public PKCE
 * clients, consent is skipped only for the checked-in ids, and every seeded
 * client receives the same API scopes.
 */
export function projectTrustedOAuthClientToRow(
	client: TrustedOAuthClientInput,
	now = new Date(),
) {
	return {
		id: client.clientId,
		clientId: client.clientId,
		disabled: TRUSTED_OAUTH_CLIENT_POLICY.disabled,
		skipConsent: TRUSTED_OAUTH_CLIENT_POLICY.skipConsent,
		scopes: [...EPICENTER_OAUTH_SCOPES],
		createdAt: now,
		updatedAt: now,
		name: client.name,
		redirectUris: [...client.redirectUris],
		tokenEndpointAuthMethod:
			TRUSTED_OAUTH_CLIENT_POLICY.tokenEndpointAuthMethod,
		grantTypes: TRUSTED_OAUTH_CLIENT_POLICY.grantTypes,
		responseTypes: TRUSTED_OAUTH_CLIENT_POLICY.responseTypes,
		public: TRUSTED_OAUTH_CLIENT_POLICY.public,
		type: client.type,
		requirePKCE: TRUSTED_OAUTH_CLIENT_POLICY.requirePKCE,
	} satisfies typeof schema.oauthClient.$inferInsert;
}

/**
 * Upsert the first-party OAuth clients Better Auth is allowed to trust.
 *
 * Call this before handling OAuth requests in a fresh database. The module-level
 * promise makes concurrent workers share one seed attempt; if the attempt fails,
 * the cache is cleared so a later request can retry instead of pinning a bad
 * startup state.
 */
export async function ensureTrustedOAuthClients(
	db: NodePgDatabase<typeof schema>,
) {
	trustedOAuthClientsSeed ??= (async () => {
		for (const client of EPICENTER_TRUSTED_OAUTH_CLIENTS) {
			const row = projectTrustedOAuthClientToRow(client);
			await db
				.insert(schema.oauthClient)
				.values(row)
				.onConflictDoUpdate({
					target: schema.oauthClient.clientId,
					set: {
						disabled: row.disabled,
						skipConsent: row.skipConsent,
						scopes: row.scopes,
						updatedAt: row.updatedAt,
						name: row.name,
						redirectUris: row.redirectUris,
						tokenEndpointAuthMethod: row.tokenEndpointAuthMethod,
						grantTypes: row.grantTypes,
						responseTypes: row.responseTypes,
						public: row.public,
						type: row.type,
						requirePKCE: row.requirePKCE,
					},
				});
		}
	})();
	try {
		await trustedOAuthClientsSeed;
	} catch (error) {
		trustedOAuthClientsSeed = null;
		throw error;
	}
}
