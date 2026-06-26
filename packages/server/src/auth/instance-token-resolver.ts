/**
 * The self-host single-user bearer credential source (ADR-0070, ADR-0071).
 *
 * A self-hosted star mints one static bearer token at first boot and prints it;
 * the operator pastes it into the client's instance setting (`{ baseURL, token }`).
 * Every request then arrives as `Authorization: Bearer <token>`, and this
 * resolver is the `ResolveUser` the deployment injects on `createServerApp` to
 * turn that bearer into the box's single owner.
 *
 * It is a credential SOURCE, not a new auth mode: it feeds the one total gate
 * exactly like `resolveRequestOAuthUser`, and it pairs with `personal()`, so the
 * 401 gate, the partition switch, and every owner-scoped route never learn that
 * "self-host" exists (ADR-0070). OAuth stays the hosted star's only; a
 * self-hosted origin authenticates with this token instead (ADR-0071).
 */

import { AuthUser } from '@epicenter/auth';
import { OAuthError } from '@epicenter/constants/oauth-errors';
import { Ok } from 'wellcrafted/result';
import type { ResolveUser } from '../types.js';
import { parseBearer } from './parse-bearer.js';

/**
 * Constant-time equality for two strings of any length.
 *
 * Both sides are first hashed to a fixed 32-byte SHA-256 digest, so the compare
 * loop runs the same length regardless of the inputs (no early-out on the first
 * differing byte and no length tell), and an attacker observing comparison
 * timing learns nothing about the configured token: they would need a preimage
 * of its digest. `crypto.subtle` is a Web Crypto global on both Bun and Workers,
 * so this stays portable and names no `node:` built-in on the shared surface.
 */
async function constantTimeEqual(a: string, b: string): Promise<boolean> {
	const encoder = new TextEncoder();
	const [digestA, digestB] = await Promise.all([
		crypto.subtle.digest('SHA-256', encoder.encode(a)),
		crypto.subtle.digest('SHA-256', encoder.encode(b)),
	]);
	const bytesA = new Uint8Array(digestA);
	const bytesB = new Uint8Array(digestB);
	let mismatch = 0;
	for (let i = 0; i < bytesA.length; i += 1) {
		mismatch |= (bytesA[i] ?? 0) ^ (bytesB[i] ?? 0);
	}
	return mismatch === 0;
}

/**
 * Build the `ResolveUser` for a token-authenticated self-host star. A request
 * whose `Authorization: Bearer <token>` matches `token` resolves to `user` (the
 * box's single owner); a missing, non-bearer, or mismatched token is an
 * `InvalidToken`, the same `Result` arm the OAuth resolver returns, so the auth
 * wrappers reject it unchanged (HTTP 401 with the OAuth `WWW-Authenticate`
 * challenge, or the rooms 4401 close).
 *
 * `user` is validated once at construction; its `id` must be stable across
 * reboots, because `personal()` keys the owner partition by it and a changed id
 * would re-partition the box's data.
 */
export function createInstanceTokenResolver(options: {
	token: string;
	user: AuthUser;
}): ResolveUser {
	const resolved = Ok(AuthUser.assert(options.user));
	const { token } = options;
	return async (c) => {
		const presented = parseBearer(c.req.header('authorization') ?? null);
		if (!presented) return OAuthError.InvalidToken();
		if (!(await constantTimeEqual(presented, token))) {
			return OAuthError.InvalidToken();
		}
		return resolved;
	};
}
