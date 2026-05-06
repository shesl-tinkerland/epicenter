import type { AuthIdentity } from '@epicenter/auth';
import { createSession, type SignedInBase } from '@epicenter/svelte';
import { getOrCreateInstallationId } from '@epicenter/workspace';
import { openFuji, type Fuji } from '../routes/(signed-in)/fuji/browser';
import { auth } from './auth';

export type FujiSignedIn = SignedInBase & {
	readonly fuji: Fuji;
};

function buildFujiSignedIn(identity: AuthIdentity): FujiSignedIn {
	const fuji = openFuji({
		identity,
		peer: {
			id: getOrCreateInstallationId(localStorage),
			name: 'Fuji',
			platform: 'web',
		},
		bearerToken: () => auth.bearerToken,
	});
	return {
		identity,
		fuji,
		[Symbol.dispose]() {
			fuji[Symbol.dispose]();
		},
	};
}

export const session = createSession<FujiSignedIn>({
	auth,
	build: buildFujiSignedIn,
	applyKeys: (signedIn, identity) =>
		signedIn.fuji.encryption.applyKeys(identity.encryptionKeys),
});

if (import.meta.hot) {
	import.meta.hot.dispose(() => session[Symbol.dispose]());
}
