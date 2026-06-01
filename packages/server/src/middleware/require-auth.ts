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
 * Both infrastructure reads (the signing keys and the user row) mean the token
 * could not be CHECKED, not that it is bad, so the HTTP status is decided by
 * WHICH step failed, not by inspecting error internals:
 *
 *   1. Verify the token against the signing keys. The keys come from
 *      `auth.api.getJwks()` (Better Auth's own JWKS projection, read from the
 *      same database in-process, with no HTTP hop to our own `/auth/jwks`,
 *      which loops back and fails inside a Cloudflare Worker). It is passed as
 *      `jwksFetch` rather than pre-fetched so Better Auth's module-level JWKS
 *      cache serves it: a token whose `kid` is already cached, or a non-JWT
 *      that never decodes far enough to need a key, costs no database read.
 *      `keysUnreadable` carries a key-read failure across that callback
 *      boundary. A verification failure with `keysUnreadable` set is a
 *      retryable 503 (the keys were unreachable, so the token was never
 *      checked); any other verification failure (bad signature, wrong
 *      audience/issuer, expired, malformed, unknown `kid`) is a 401.
 *
 *   2. Look up the subject. A database failure here is again infrastructure
 *      (a retryable 503); a successful query that finds no row is a genuine
 *      401 (the subject was deleted).
 *
 * A 503 matters because returning 401 on an infrastructure fault would make
 * the client discard and refresh a token that may be perfectly good, and pause
 * network auth over a transient server blip.
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

	const audience = c.var.authBaseURL;
	let keysUnreadable = false;
	let payload: Awaited<ReturnType<typeof verifyJwsAccessToken>>;
	try {
		payload = await verifyJwsAccessToken(accessToken, {
			jwksFetch: async () => {
				try {
					return await c.var.auth.api.getJwks();
				} catch {
					keysUnreadable = true;
					return undefined;
				}
			},
			verifyOptions: { audience, issuer: createOAuthIssuerURL(audience) },
		});
	} catch {
		return keysUnreadable
			? OAuthError.ServerError()
			: OAuthError.InvalidToken();
	}

	const userId = typeof payload?.sub === 'string' ? payload.sub : null;
	if (!userId) return OAuthError.InvalidToken();

	let user: Awaited<ReturnType<typeof c.var.db.query.user.findFirst>>;
	try {
		user = await c.var.db.query.user.findFirst({
			where: eq(schema.user.id, userId),
		});
	} catch {
		return OAuthError.ServerError();
	}
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
