import { requireSignedIn } from '@epicenter/auth';
import {
	BearerSession,
	createBearerAuth,
	waitForAuthState,
} from '@epicenter/auth-svelte';
import { APP_URLS } from '@epicenter/constants/vite';
import { createPersistedState } from '@epicenter/svelte';
import { getOrCreateInstallationId } from '@epicenter/workspace';
import { actionsToAiTools } from '@epicenter/workspace/ai';
import { openOpensidian } from './browser';

const session = createPersistedState({
	key: 'opensidian:authSession',
	schema: BearerSession.or('null'),
	defaultValue: null,
});

export const auth = createBearerAuth({
	baseURL: APP_URLS.API,
	initialSession: session.get(),
	saveSession: (next) => session.set(next),
});

const signedInState = await waitForAuthState(
	auth,
	(state) => state.status === 'signed-in',
);
if (signedInState.status !== 'signed-in') {
	throw new Error('Cannot open Opensidian workspace: signed-in auth required.');
}
const userId = signedInState.identity.user.id;

export const opensidian = openOpensidian({
	userId,
	peer: {
		id: getOrCreateInstallationId(localStorage),
		name: 'Opensidian',
		platform: 'web',
	},
	bearerToken: () => auth.bearerToken,
	encryptionKeys: () => requireSignedIn(auth).encryptionKeys,
});

const unsubscribeAuthState = auth.onStateChange((state) => {
	switch (state.status) {
		case 'pending':
			return;
		case 'signed-out':
			return window.location.reload();
		case 'signed-in':
			if (state.identity.user.id !== userId) window.location.reload();
			return;
		default:
			state satisfies never;
	}
});

export async function forgetOpensidianDevice(): Promise<void> {
	await opensidian.wipe();
	window.location.reload();
}

if (import.meta.hot) {
	import.meta.hot.dispose(() => {
		unsubscribeAuthState();
		auth[Symbol.dispose]();
		opensidian[Symbol.dispose]();
	});
}

/** AI tool representations for the opensidian workspace. */
export const workspaceAiTools = actionsToAiTools(opensidian.actions);

/** Tool array type for use in TanStack AI generics. */
export type WorkspaceTools = typeof workspaceAiTools.tools;
