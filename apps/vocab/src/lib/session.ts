import { createSession } from '@epicenter/svelte/auth';
import { openVocabBrowser } from '@epicenter/vocab/browser';
import { createNodeId } from '@epicenter/workspace';
import { auth } from '$platform/auth';

export const session = createSession({
	auth,
	build: (signedIn) =>
		openVocabBrowser({
			signedIn,
			nodeId: createNodeId({ storage: localStorage }),
		}),
});

export const requireVocab = session.require;

if (import.meta.hot) {
	import.meta.hot.dispose(() => session[Symbol.dispose]());
}
