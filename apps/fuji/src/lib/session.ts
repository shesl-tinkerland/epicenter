import { createSession } from '@epicenter/svelte';
import { createDeviceId } from '@epicenter/workspace';
import { auth } from '$lib/auth';
import { openFujiBrowser } from '../../fuji.browser';
import { createEntriesState } from './entries-state.svelte';

export const session = createSession({
	auth,
	build: (signedIn) => {
		const fuji = openFujiBrowser({
			signedIn,
			deviceId: createDeviceId({ storage: localStorage }),
		});
		const entries = createEntriesState(fuji);
		return {
			...fuji,
			entries,
			[Symbol.dispose]() {
				entries[Symbol.dispose]();
				fuji[Symbol.dispose]();
			},
		};
	},
});

export const requireFuji = session.require;

if (import.meta.hot) {
	import.meta.hot.dispose(() => session[Symbol.dispose]());
}
