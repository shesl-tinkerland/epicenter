import { subjectKeyringsEqual } from '@epicenter/encryption';
import {
	defineErrors,
	extractErrorMessage,
} from 'wellcrafted/error';
import { createLogger, type Logger } from 'wellcrafted/logger';
import type { AuthState } from './auth-contract.js';

const AuthStateStoreError = defineErrors({
	SubscriberThrew: ({ cause }: { cause: unknown }) => ({
		message: `Auth state subscriber threw: ${extractErrorMessage(cause)}`,
		cause,
	}),
});

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
	return (
		left.localIdentity.subject === right.localIdentity.subject &&
		subjectKeyringsEqual(
			left.localIdentity.keyring,
			right.localIdentity.keyring,
		)
	);
}
