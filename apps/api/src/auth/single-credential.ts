import { BEARER_SUBPROTOCOL_PREFIX, parseSubprotocols } from '@epicenter/sync';
import { getSessionCookie } from 'better-auth/cookies';
import { createMiddleware } from 'hono/factory';
import { HTTPException } from 'hono/http-exception';

/**
 * Reject requests that carry more than one authentication credential and lift
 * any WebSocket subprotocol bearer into `Authorization` so downstream code
 * (Better Auth's `getSession`) sees one canonical input.
 *
 * ## Why this exists
 *
 * Better Auth's bearer plugin silently resolves the cookie-vs-bearer ambiguity
 * in undocumented, historically buggy ways. Verified upstream against
 * `packages/better-auth/src/plugins/bearer/index.ts`:
 *
 * - A valid `Authorization: Bearer` overwrites the session cookie internally.
 * - An invalid bearer is silently dropped, so a stale cookie can take over
 *   (`bearer.test.ts` literally tests this fallback).
 * - The 2026 changeset `fix-bearer-cookie-parse-mutate-serialize.md` fixed a
 *   bug where the merged `Cookie` header carried two `session_token` entries
 *   and downstream readers picked the stale one.
 *
 * Allowing clients to send both credentials is therefore a footgun. This
 * middleware removes the implicit decision: every request must carry at most
 * one credential; ambiguous requests are rejected at the edge before any
 * session lookup happens.
 *
 * ## What it does
 *
 * 1. Checks for the Better Auth session cookie via `getSessionCookie` from
 *    `better-auth/cookies` with no options. The library defaults
 *    (`cookiePrefix: 'better-auth'`, `cookieName: 'session_token'`) match the
 *    names Better Auth itself uses internally as long as `BASE_AUTH_CONFIG`
 *    does not set `advanced.cookiePrefix` or `advanced.cookies.session_token.name`.
 *    `getSessionCookie` itself handles the `__Secure-` prefix and the legacy
 *    dash-form fallback. If you ever override either of those auth options,
 *    pass the same value here so the lookup stays in sync.
 * 2. Parses HTTP `Authorization: Bearer <token>` and the WebSocket bearer
 *    subprotocol `sec-websocket-protocol: epicenter, bearer.<token>`. Browsers
 *    cannot set `Authorization` on `new WebSocket(url)` upgrades, so the
 *    subprotocol is the only smuggling channel for WS auth.
 * 3. If a cookie and a bearer are both present, or two bearers disagree, throws
 *    HTTP 400. Otherwise, if only a WS bearer is present, mutates `c.req.raw`
 *    so downstream handlers see `Authorization: Bearer` directly. This is the
 *    same in-place rewrite pattern Hono's own `bodyLimit` middleware uses
 *    (`hono/src/middleware/body-limit/index.ts`).
 *
 * Mount globally so the well-formedness check runs on every route.
 */
export const singleCredential = createMiddleware(async (c, next) => {
	const headers = c.req.raw.headers;
	const cookie = getSessionCookie(c.req.raw);
	const httpBearer = parseHttpBearer(headers.get('authorization'));
	const wsBearer = parseWsBearer(headers.get('sec-websocket-protocol'));
	const isWebSocketUpgrade = headers.get('upgrade') === 'websocket';

	// WebSocket auth is bearer-only. Browsers attach cookies to WS handshakes
	// regardless of SameSite, and CORS cannot block the upgrade (101 headers
	// are immutable). Without this rejection, a cross-origin page could open
	// authenticated WS connections in the victim's browser. Every real WS
	// client (Tauri, dashboard, tab-manager) sends a bearer subprotocol; see
	// `parseWsBearer` below.
	if (isWebSocketUpgrade && cookie && !wsBearer) {
		throw new HTTPException(401, { message: 'ws_requires_bearer' });
	}

	if (cookie && (httpBearer || wsBearer)) {
		throw new HTTPException(400, { message: 'multiple_credentials' });
	}
	if (httpBearer && wsBearer && httpBearer !== wsBearer) {
		throw new HTTPException(400, { message: 'multiple_credentials' });
	}

	if (wsBearer && !httpBearer) {
		const normalized = new Headers(headers);
		normalized.set('authorization', `Bearer ${wsBearer}`);
		c.req.raw = new Request(c.req.raw, { headers: normalized });
	}

	await next();
});

function parseHttpBearer(value: string | null): string | null {
	if (!value) return null;
	const match = value.match(/^Bearer\s+(.+)$/i);
	return match?.[1]?.trim() || null;
}

function parseWsBearer(value: string | null): string | null {
	const entry = parseSubprotocols(value).find((protocol) =>
		protocol.startsWith(BEARER_SUBPROTOCOL_PREFIX),
	);
	return entry ? entry.slice(BEARER_SUBPROTOCOL_PREFIX.length) : null;
}
