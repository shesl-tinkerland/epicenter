import { createSession } from '@epicenter/svelte';
import { createDeviceId } from '@epicenter/workspace';
import { auth } from '$platform/auth';
import { openZhongwenBrowser } from '../../zhongwen.browser';

export const session = createSession({
	auth,
	build: (signedIn) =>
		openZhongwenBrowser({
			signedIn,
			deviceId: createDeviceId({ storage: localStorage }),
		}),
});

export const requireZhongwen = session.require;

if (import.meta.hot) {
	import.meta.hot.dispose(() => session[Symbol.dispose]());
}
