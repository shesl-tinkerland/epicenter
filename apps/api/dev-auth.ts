/**
 * Dev-only credential bypass for the runtime-parity smoke.
 *
 * `Authorization: Bearer dev:<userId>` resolves to the user
 * `{ id: <userId>, email: <userId>@dev.invalid }` with no interactive login.
 * It exists so `apps/api/scripts/smoke.ts` (and CI) can drive the authed
 * surfaces without Google OAuth or a forged Better Auth session, which is the
 * only thing that scenario cannot obtain over plain HTTP.
 *
 * This IS a bypass, so it is quarantined: it is wired ONLY by `server.dev.ts`,
 * which the production entrypoints (`worker/index.ts`, `server.ts`) never
 * import, so it cannot ship. It is a `ResolveUser` injected on
 * `createServerApp`, never an env-gated branch inside `@epicenter/server` (that
 * would compile the bypass into production). Belt-and-suspenders: it refuses
 * unless the request landed on localhost, so even a misconfigured deploy that
 * somehow wired it would admit nobody off-box.
 *
 * In personal mode the resolved `id` becomes the owner partition directly (no
 * user row is read), so the smoke needs no seeded user and no database access
 * of its own.
 */

import { AuthUser, asUserId } from '@epicenter/auth';
import { OAuthError } from '@epicenter/constants/oauth-errors';
import type { ResolveUser } from '@epicenter/server/bun';
import { Ok } from 'wellcrafted/result';

const BEARER_PREFIX = 'Bearer ';
const DEV_TOKEN_PREFIX = 'dev:';
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1']);

/**
 * Resolve `Authorization: Bearer dev:<userId>` to a synthetic user, on
 * localhost only. Any other request (off-box, missing header, non-`dev:`
 * token, empty id) is an `InvalidToken`, the same `Result` arm the real
 * resolver returns, so the surface wrappers reject it unchanged.
 */
export const resolveDevUser: ResolveUser = async (c) => {
	const hostname = new URL(c.req.url).hostname;
	if (!LOCAL_HOSTNAMES.has(hostname)) return OAuthError.InvalidToken();

	const header = c.req.header('authorization') ?? '';
	const token = header.startsWith(BEARER_PREFIX)
		? header.slice(BEARER_PREFIX.length)
		: '';
	if (!token.startsWith(DEV_TOKEN_PREFIX)) return OAuthError.InvalidToken();

	const userId = token.slice(DEV_TOKEN_PREFIX.length);
	if (!userId) return OAuthError.InvalidToken();

	return Ok(
		AuthUser.assert({ id: asUserId(userId), email: `${userId}@dev.invalid` }),
	);
};
