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
			if (state.status === next.status) {
				if (state.status === 'signed-out') return;
				if (
					next.status !== 'signed-out' &&
					state.localIdentity.subject === next.localIdentity.subject &&
					subjectKeyringsEqual(
						state.localIdentity.keyring,
						next.localIdentity.keyring,
					)
				) {
					return;
				}
			}
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
