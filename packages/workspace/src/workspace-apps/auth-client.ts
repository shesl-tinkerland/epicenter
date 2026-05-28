import type { OwnerId } from '@epicenter/constants/identity';
import type { Keyring } from '@epicenter/encryption';

/**
 * Workspace's structural view of an auth client's published state.
 *
 * Pinned here (not imported from `@epicenter/auth`) so workspace stays a
 * standalone local-first primitive: a desktop or CLI consumer that never
 * signs in does not need to install an auth package. Apps wired to
 * `@epicenter/auth` get this for free because the real `AuthState` matches
 * structurally.
 */
export type WorkspaceAuthState =
	| { status: 'signed-out' }
	| {
			status: 'signed-in';
			ownerId: OwnerId;
			keyring: Keyring;
	  }
	| {
			status: 'reauth-required';
			ownerId: OwnerId;
			keyring: Keyring;
	  };

/**
 * Workspace's structural view of an auth client. Any object whose shape
 * matches (notably `@epicenter/auth`'s `AuthClient`) can be passed to
 * `startProjectMounts`.
 *
 * Workspace reads three surfaces: the discriminated `state` (to gate startup
 * on signed-in and to derive the lazy keyring reader), `openWebSocket` (for
 * collaboration sockets with the bearer subprotocol attached), and
 * `onStateChange` (for the reconnect signal). The narrow contract is what
 * lets this package compile without depending on `@epicenter/auth`.
 */
export type WorkspaceAuthClient = {
	state: WorkspaceAuthState;
	openWebSocket(url: string | URL, protocols?: string[]): Promise<WebSocket>;
	onStateChange(fn: (state: WorkspaceAuthState) => void): () => void;
};
