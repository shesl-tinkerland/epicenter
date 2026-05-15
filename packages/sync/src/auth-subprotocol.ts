import { BEARER_SUBPROTOCOL_PREFIX } from '@epicenter/constants/auth';

/**
 * WebSocket subprotocol auth: shared client/server constants.
 *
 * Auth tokens travel inside the `Sec-WebSocket-Protocol` handshake header
 * as `bearer.<token>`, not in the URL's query string. The real threat is
 * server-side access logs (Cloudflare, Hono middleware, downstream APMs
 * like Sentry/Datadog): full URLs including query strings are captured by
 * default, so a `?token=` scheme leaks long-lived session tokens into any
 * system with log access. Subprotocol headers aren't captured by default
 * on those systems. The server extracts and consumes the bearer entry on
 * upgrade; only the main protocol name (`epicenter`) is echoed back on
 * the 101 response, so the token never round-trips.
 *
 * The `.` separator is required by RFC compliance: `Sec-WebSocket-Protocol`
 * values are RFC 7230 `token` productions, where `:` is not a valid `tchar`
 * but `.` is. Prior art for `<scheme>.<token>`: Phoenix channels
 * (`phx_bearer.<token>`), Supabase Realtime, and Kubernetes
 * (`base64url.bearer.authorization.k8s.io.<token>`).
 */

/** Primary subprotocol name every Epicenter client negotiates. */
export const MAIN_SUBPROTOCOL = 'epicenter';

export { BEARER_SUBPROTOCOL_PREFIX };

/**
 * Parse a `Sec-WebSocket-Protocol` header value into its list of tokens.
 *
 * RFC 6455 specifies the value as a comma-separated list of RFC 7230 tokens,
 * with optional whitespace after commas. Returns an empty list if the header
 * is absent.
 */
export function parseSubprotocols(header: string | null): string[] {
	if (!header) return [];
	return header.split(',').map((s) => s.trim());
}

/**
 * Extract the bearer token from a `Sec-WebSocket-Protocol` header, if present.
 *
 * The client encodes the token as `bearer.<token>` in the subprotocol list.
 * Returns `null` when no bearer entry is offered (e.g. cookie-only browser
 * auth, or an unauthenticated request the caller will reject downstream).
 */
export function extractBearerToken(headers: Headers): string | null {
	const offered = headers.get('sec-websocket-protocol');
	const bearer = parseSubprotocols(offered).find((s) =>
		s.startsWith(BEARER_SUBPROTOCOL_PREFIX),
	);
	return bearer ? bearer.slice(BEARER_SUBPROTOCOL_PREFIX.length) : null;
}
