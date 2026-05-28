import { createSession } from '@epicenter/svelte';
import { createDeviceId } from '@epicenter/workspace';
import { auth } from '$platform/auth';
import { openHoneycrispBrowser } from '../../honeycrisp.browser';
import { createHoneycrispState } from '../routes/(signed-in)/state';

export const session = createSession({
	auth,
	build: (signedIn) => {
		const honeycrisp = openHoneycrispBrowser({
			signedIn,
			deviceId: createDeviceId({ storage: localStorage }),
		});
		const state = createHoneycrispState(honeycrisp);
		return {
			...honeycrisp,
			state,
			[Symbol.dispose]() {
				state[Symbol.dispose]();
				honeycrisp[Symbol.dispose]();
			},
		};
	},
});

export const requireHoneycrisp = session.require;

if (import.meta.hot) {
	import.meta.hot.dispose(() => session[Symbol.dispose]());
}
