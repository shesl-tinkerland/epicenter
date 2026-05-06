import { createContext } from 'svelte';
import type { Entry, EntryId } from '../routes/(signed-in)/fuji/workspace';
import type { FujiSignedIn } from './session.svelte';

export type FujiSignedInSession = FujiSignedIn & {
	entries: {
		get: (id: EntryId) => Entry | undefined;
		readonly active: Entry[];
		readonly deleted: Entry[];
	};
};

const [getSignedInSessionRaw, setSignedInSessionInternal] =
	createContext<FujiSignedInSession>();

export const setSignedInSession = setSignedInSessionInternal;

export function getSignedInSession(): FujiSignedInSession {
	const session = getSignedInSessionRaw();
	if (!session) {
		throw new Error(
			'[fuji] getSignedInSession() called outside <SignedInSessionProvider>. ' +
				'This route must mount under the signed-in branch of the root layout.',
		);
	}
	return session;
}
