import { createSession } from '@epicenter/svelte/auth';
import { createDeviceId } from '@epicenter/workspace';
import { openZhongwenBrowser } from '@epicenter/zhongwen/browser';
import { auth } from '$platform/auth';

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
