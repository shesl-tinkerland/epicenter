import { oauthProviderResourceClient } from '@better-auth/oauth-provider/resource-client';
import {
	AuthUser,
	type AuthUser as AuthUserType,
	type LocalWorkspaceIdentity,
} from '@epicenter/auth';
import type { SubjectKeyring } from '@epicenter/encryption';
import type { User } from 'better-auth';
import { eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Context } from 'hono';
import { Err, Ok, type Result } from 'wellcrafted/result';
import * as schema from '../db/schema';
import { hasScope, OAuthError, WORKSPACES_OPEN_SCOPE } from './oauth-error.js';
import { createOAuthIssuerURL, createOAuthJwksURL } from './oauth-metadata.js';

export { WORKSPACES_OPEN_SCOPE };

export type WorkspaceIdentity = {
	user: AuthUserType;
	localIdentity: LocalWorkspaceIdentity;
};

type VerifyOAuthAccessToken = ReturnType<
	ReturnType<typeof oauthProviderResourceClient>['getActions']
>['verifyAccessToken'];

type ResolverDeps = {
	authorization: string | null;
	audience: string;
	issuer: string;
	jwksUrl: string;
	verifyOAuthAccessToken: VerifyOAuthAccessToken;
	findUserById(userId: string): Promise<User | null>;
};

type RequestOAuthEnv = {
	Bindings: object | undefined;
	Variables: {
		authBaseURL: string;
		db: NodePgDatabase<typeof schema>;
	};
};

/**
 * Extract the token from an HTTP `Authorization: Bearer <token>` header value.
 * Case-insensitive on the scheme; trims surrounding whitespace; returns null
 * for missing, empty, or non-bearer inputs.
 *
 * Shared with `single-credential.ts` so well-formedness and authorization
 * agree on what counts as a bearer.
 */
export function parseBearer(value: string | null): string | null {
	if (!value) return null;
	const match = value.match(/^Bearer\s+(.+)$/i);
	return match?.[1]?.trim() || null;
}

/**
 * Verify a bearer access token, enforce the `workspaces:open` scope, and
 * resolve the calling Better Auth user. The single source of truth for what
 * "a token good enough to reach a protected resource" means in this codebase.
 *
 * Wrappers project the user differently:
 * - `resolveBearerUser` returns the lean `AuthUser` for the middleware path.
 * - `resolveBearerIdentity` adds the derived local workspace identity for
 *   `/api/me`.
 */
async function verifyBearerToUser(
	deps: ResolverDeps,
): Promise<Result<User, OAuthError>> {
	const accessToken = parseBearer(deps.authorization);
	if (!accessToken) return OAuthError.InvalidToken();

	const payload = await deps
		.verifyOAuthAccessToken(accessToken, {
			verifyOptions: { audience: deps.audience, issuer: deps.issuer },
			jwksUrl: deps.jwksUrl,
		})
		.catch(() => null);
	const userId = typeof payload?.sub === 'string' ? payload.sub : null;
	if (!userId) return OAuthError.InvalidToken();

	if (!hasScope(payload, WORKSPACES_OPEN_SCOPE)) {
		return OAuthError.InsufficientScope({ scope: WORKSPACES_OPEN_SCOPE });
	}

	const user = await deps.findUserById(userId);
	if (!user) return OAuthError.InvalidToken();

	return Ok(user);
}

/**
 * Cheap resolver for the protected-resource boundary (`/ai/*`,
 * `/rooms/*`, `/api/billing/*`, `/api/assets/*`).
 * Skips subject keyring derivation; only the calling user is needed once
 * the scope is proven.
 */
export async function resolveBearerUser(
	deps: ResolverDeps,
): Promise<Result<AuthUser, OAuthError>> {
	const { data: user, error } = await verifyBearerToUser(deps);
	if (error) return Err(error);
	return Ok({ id: user.id, email: user.email });
}

/**
 * Full resolver for `/api/me`. Returns the local-first payload the apps
 * need at boot: the calling user plus the per-subject keyring derived from
 * the root keyring.
 */
export async function resolveBearerIdentity(
	deps: ResolverDeps & {
		deriveSubjectKeyring(subject: string): Promise<SubjectKeyring>;
	},
): Promise<Result<WorkspaceIdentity, OAuthError>> {
	const { data: user, error } = await verifyBearerToUser(deps);
	if (error) return Err(error);
	return Ok({
		user: AuthUser.assert(user),
		localIdentity: {
			subject: user.id,
			keyring: await deps.deriveSubjectKeyring(user.id),
		},
	});
}

/**
 * Resolve the OAuth bearer on the current request to the calling user.
 * This is the Hono adapter around the pure bearer resolver above.
 */
export function resolveRequestOAuthUser<E extends RequestOAuthEnv>(
	c: Context<E>,
) {
	return resolveBearerUser(createResolverDeps(c));
}

/**
 * Resolve the OAuth bearer on the current request to the full workspace
 * identity payload. Subject keyring derivation stays injected so this module
 * remains free of Worker-only imports and easy to test through the pure
 * resolver.
 */
export function resolveRequestWorkspaceIdentity<E extends RequestOAuthEnv>(
	c: Context<E>,
	deriveSubjectKeyring: (subject: string) => Promise<SubjectKeyring>,
) {
	return resolveBearerIdentity({
		...createResolverDeps(c),
		deriveSubjectKeyring,
	});
}

function createResolverDeps<E extends RequestOAuthEnv>(c: Context<E>) {
	const audience = c.var.authBaseURL;
	return {
		authorization: c.req.header('authorization') ?? null,
		audience,
		issuer: createOAuthIssuerURL(audience),
		jwksUrl: createOAuthJwksURL(audience),
		verifyOAuthAccessToken:
			oauthProviderResourceClient().getActions().verifyAccessToken,
		findUserById: async (userId) => {
			const [row] = await c.var.db
				.select()
				.from(schema.user)
				.where(eq(schema.user.id, userId))
				.limit(1);
			return row ?? null;
		},
	} satisfies ResolverDeps;
}
