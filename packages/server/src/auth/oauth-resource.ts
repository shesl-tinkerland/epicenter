import type { OAuthError } from '@epicenter/constants/oauth-errors';
import type { Context } from 'hono';
import { isWebSocketUpgrade } from '../is-websocket-upgrade.js';

type CreateWebSocketPair = () => InstanceType<typeof WebSocketPair>;

/**
 * Map an {@link OAuthError} to the protected-resource failure response for HTTP
 * and WebSocket-upgrade requests on the same route.
 *
 * The serialized error object (`{ name, message, ...fields }`) is itself the
 * JSON body and the WS close-reason payload; clients reconstruct by branching
 * on `error.name`. The HTTP status (and the WS close code, `4000 + status`)
 * come from the error: `InvalidToken` is 401 with a `WWW-Authenticate`
 * challenge, while `ServerError` is a 503 the client should retry rather than
 * treat as a rejected token.
 */
export function createOAuthUnauthorizedResourceResponse(
	c: Context,
	error: OAuthError,
	// Injectable so the WebSocket close path is testable: `WebSocketPair` is a
	// Cloudflare Workers global that does not exist in the Bun test runtime, and
	// the test needs to observe the close code and reason on the server socket.
	// Production always uses the default.
	createWebSocketPair: CreateWebSocketPair = () => new WebSocketPair(),
) {
	const isUpgrade = isWebSocketUpgrade(c);

	if (!isUpgrade) {
		// A bearer challenge only belongs on an actual auth rejection, not a 503.
		if (error.status === 401) {
			c.header('WWW-Authenticate', 'Bearer error="invalid_token"');
		}
		return c.json(error, error.status);
	}
	const pair = createWebSocketPair();
	const [client, server] = [pair[0], pair[1]];
	server.accept();
	// WebSocket app-close codes are HTTP status + 4000 (401 -> 4401, 503 ->
	// 4503). The client's sync supervisor treats only 4401 as permanent, so a
	// 4503 reconnects with backoff.
	server.close(4000 + error.status, JSON.stringify(error));
	return new Response(null, { status: 101, webSocket: client });
}
