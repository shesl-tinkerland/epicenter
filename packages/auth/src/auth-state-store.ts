import { encryptionKeysEqual } from '@epicenter/encryption';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { createLogger, type Logger } from 'wellcrafted/logger';
import type { AuthState } from './auth-contract.js';
import type { LocalUnlockBundle } from './auth-types.js';

export const AuthStateStoreError = defineErrors({
	SubscriberThrew: ({ cause }: { cause: unknown }) => ({
		message: `Auth state subscriber threw: ${extractErrorMessage(cause)}`,
		cause,
	}),
});
export type AuthStateStoreError = InferErrors<typeof AuthStateStoreError>;

export function createAuthStateStore(
	initialState: AuthState,
	{ log = createLogger('auth/state-store') }: { log?: Logger } = {},
) {
	let state = initialState;
	const stateChangeListeners = new Set<(state: AuthState) => void>();

	return {
		get state() {
			return state;
		},
		setState(next: AuthState) {
			if (authStatesEqual(state, next)) return;
			state = next;
			for (const listener of stateChangeListeners) {
				try {
					listener(next);
				} catch (error) {
					log.error(AuthStateStoreError.SubscriberThrew({ cause: error }));
				}
			}
		},
		onStateChange(fn: (state: AuthState) => void) {
			stateChangeListeners.add(fn);
			return () => {
				stateChangeListeners.delete(fn);
			};
		},
		clearListeners() {
			stateChangeListeners.clear();
		},
	};
}

function authStatesEqual(left: AuthState, right: AuthState): boolean {
	if (left.status !== right.status) return false;
	if (left.status === 'signed-out' || right.status === 'signed-out') {
		return left.status === right.status;
	}
	return unlocksEqual(left.unlock, right.unlock);
}

function unlocksEqual(
	left: LocalUnlockBundle,
	right: LocalUnlockBundle,
): boolean {
	return (
		left.userId === right.userId &&
		encryptionKeysEqual(left.encryptionKeys, right.encryptionKeys)
	);
}
