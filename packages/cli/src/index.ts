/** @module @epicenter/cli. Public API for the Epicenter CLI package. */

export { type AuthApi, createAuthApi } from './auth/api';
export {
	attachSessionUnlock,
	type SessionUnlockAttachment,
} from './auth/attach-session-unlock';
export { epicenterPaths } from './auth/paths';
export {
	type AuthSession,
	createSessionStore,
	type SessionStore,
} from './auth/session-store';
export { createCLI } from './cli';
export {
	connectWorkspace,
	type ConnectedWorkspace,
	type ConnectWorkspaceOptions,
} from './connect';
export { type LoadConfigResult, loadConfig } from './load-config';
