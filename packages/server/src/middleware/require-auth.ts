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
 * Resolve an OAuth bearer token to the calling user.
 *
 * The signing keys are read in-process through `jwksFetch` (Better Auth's own
 * JWKS projection), not by fetching our own `/auth/jwks`, whose same-zone
 * loopback does not resolve inside a Cloudflare Worker. Passing a callback lets
 * Better Auth's module cache satisfy a known `kid` with no database read.
 *
 * A failed key read or subject lookup is retryable infrastructure (503); a bad
 * token and a missing subject are client auth failures (401). The split is
 * observable: 503 tells the client to retry, 401 to discard and refresh.
 */
async function resolveRequestOAuthUser(
	c: Context<Env>,
): Promise<Result<AuthUser, OAuthError>> {
	const accessToken = parseBearer(c.req.header('authorization') ?? null);
	if (!accessToken) return OAuthError.InvalidToken();

	const audience = c.var.authBaseURL;
	// Thrown by the key-read callback and matched by identity after verification
	// fails, so "keys unreachable" (503) is told apart from "token bad" (401)
	// without sniffing the verifier's error internals.
	const keysUnreadable = new Error('JWKS read failed');
	let payload: Awaited<ReturnType<typeof verifyJwsAccessToken>>;
	try {
		payload = await verifyJwsAccessToken(accessToken, {
			jwksFetch: async () => {
				try {
					return await c.var.auth.api.getJwks();
				} catch {
					throw keysUnreadable;
				}
			},
			verifyOptions: { audience, issuer: createOAuthIssuerURL(audience) },
		});
	} catch (error) {
		return error === keysUnreadable
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
