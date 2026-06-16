import { os } from '#platform/os';

let accessibilityGranted = $state(!os.isApple);
let listenerAlive = $state(false);

export const environment = {
	get accessibilityGranted() {
		return accessibilityGranted;
	},
	get listenerAlive() {
		return listenerAlive;
	},
	setAccessibilityGranted(next: boolean) {
		accessibilityGranted = next;
	},
	setListenerAlive(next: boolean) {
		listenerAlive = next;
	},
};
