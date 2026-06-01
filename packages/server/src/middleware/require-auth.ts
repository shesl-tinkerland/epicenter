/**
 * Cookie-or-bearer authentication.
 *
 * Resolves `c.var.user` from a Better Auth session cookie if one is
 * present; otherwise falls back to an OAuth bearer for the API audience.
 * Use this on routes served to both first-party browser callers (portal,
 * dashboard, hosted UIs) and external OAuth clients (CLI, Tauri,
 * extension).
 *
 * For routes that are external-clients only (`/api/ai/*`, `/api/.../rooms/*`),
 * prefer {@link requireBearerUser}, which skips the cookie attempt.
 *
 * Cookie-vs-bearer is resolved deterministically here, cookie-first: a
 * request carrying both uses the cookie session and never consults the
 * bearer. The two credentials are read by disjoint paths and never merge,
 * so there is nothing to police at the edge: `getSession` reads only the
 * cookie (Better Auth's `bearer()` plugin is not enabled), while the OAuth
 * bearer is a JWT verified against JWKS by {@link resolveRequestOAuthUser}.
 */

import { AuthUser } from '@epicenter/auth';
import { OAuthError } from '@epicenter/constants/oauth-errors';
import { verifyJwsAccessToken } from 'better-auth/oauth2';
import { eq } from 'drizzle-orm';
import type { Context } from 'hono';
import { createMiddleware } from 'hono/factory';
import { Ok, type Result } from 'wellcrafted/result';
import { createOAuthIssuerURL } from '../auth/oauth-metadata.js';
import { createOAuthUnauthorizedResourceResponse } from '../auth/oauth-resource.js';
import { parseBearer } from '../auth/parse-bearer.js';
import * as schema from '../db/schema/index.js';
import type { Env } from '../types.js';

/**
 * Resolve the OAuth bearer on the current request to the calling user.
 *
 * Verification is two operations whose failures mean different things, so the
 * HTTP status is decided by WHICH step failed, not by inspecting error
 * internals:
 *
 *   1. Read the signing keys. `auth.api.getJwks()` is Better Auth's own JWKS
 *      projection, read from the same database in-process, with no HTTP hop to
 *      our own `/auth/jwks` (that loopback fails inside a Cloudflare Worker).
 *      A failure here is infrastructure: the token was never checked, so it is
 *      a retryable 503, never a rejection. A 401 would make the client discard
 *      and refresh a good token over a transient server fault.
 *
 *   2. Verify the token against those keys. Any failure here (bad signature,
 *      wrong audience/issuer, expired, malformed, unknown `kid`) is a genuine
 *      bad token: a 401. Because the keys are already in hand, `jwksFetch`
 *      cannot fail, so nothing infrastructural leaks into this branch.
 *
 * The API origin (`c.var.authBaseURL`) is the resource audience; the same
 * origin plus `/auth` is the issuer. Cheap by design: skips owner keyring
 * derivation, since only the calling user is needed once the token proves
 * issuer, audience, signature, expiration, and subject.
 */
async function resolveRequestOAuthUser(
	c: Context<Env>,
): Promise<Result<AuthUser, OAuthError>> {
	const accessToken = parseBearer(c.req.header('authorization') ?? null);
	if (!accessToken) return OAuthError.InvalidToken();

	let jwks: Awaited<ReturnType<typeof c.var.auth.api.getJwks>>;
	try {
		jwks = await c.var.auth.api.getJwks();
	} catch {
		return OAuthError.ServerError();
	}

	const audience = c.var.authBaseURL;
	let payload: Awaited<ReturnType<typeof verifyJwsAccessToken>>;
	try {
		payload = await verifyJwsAccessToken(accessToken, {
			jwksFetch: async () => jwks,
			verifyOptions: { audience, issuer: createOAuthIssuerURL(audience) },
		});
	} catch {
		return OAuthError.InvalidToken();
	}

	const userId = typeof payload?.sub === 'string' ? payload.sub : null;
	if (!userId) return OAuthError.InvalidToken();

	const user = await c.var.db.query.user.findFirst({
		where: eq(schema.user.id, userId),
	});
	if (!user) return OAuthError.InvalidToken();

	return Ok(AuthUser.assert(user));
}

export const requireCookieOrBearerUser = createMiddleware<Env>(
	async (c, next) => {
		const session = await c.var.auth.api.getSession({
			headers: c.req.raw.headers,
		});
		if (session) {
			c.set('user', AuthUser.assert(session.user));
			return next();
		}
		const { data: user, error } = await resolveRequestOAuthUser(c);
		if (error) return createOAuthUnauthorizedResourceResponse(c, error);
		c.set('user', user);
		await next();
	},
);

/**
 * Bearer-only authentication. Same as {@link requireCookieOrBearerUser}
 * but skips the cookie path, so the route always reports 401 with a
 * standard OAuth `WWW-Authenticate` header instead of the cookie failure
 * path. Use on protected resource routes that should never see a browser
 * cookie (rooms, AI chat).
 */
export const requireBearerUser = createMiddleware<Env>(async (c, next) => {
	const { data: user, error } = await resolveRequestOAuthUser(c);
	if (error) return createOAuthUnauthorizedResourceResponse(c, error);
	c.set('user', user);
	await next();
});
