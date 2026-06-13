import type { AuthState } from '@epicenter/identity';
import type { AuthedFetch } from '../shared/types.js';

/**
 * Workspace's structural view of an auth client. Any object whose shape
 * matches (notably `@epicenter/auth`'s `AuthClient`) can be passed to
 * `openProject`.
 *
 * Workspace reads four surfaces: the discriminated `state` (to gate startup
 * on signed-in and to derive the lazy keyring reader), `openWebSocket` (for
 * collaboration sockets with the bearer subprotocol attached), `fetch` (the
 * authed `fetch` for one-shot HTTP to the relay), and `onStateChange` (for the
 * reconnect signal). The narrow contract is what lets this package compile
 * without depending on `@epicenter/auth`.
 */
export type WorkspaceAuthClient = {
	state: AuthState;
	openWebSocket(url: string | URL, protocols?: string[]): Promise<WebSocket>;
	fetch: AuthedFetch;
	onStateChange(fn: (state: AuthState) => void): () => void;
};
