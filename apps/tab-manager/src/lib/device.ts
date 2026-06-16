/**
 * Device identity helpers for the tab-manager extension.
 *
 * The extension publishes a framework node id in presence (install-stable id)
 * and seeds a row in the local `devices` table with a human-readable name. The
 * node id is the wire concept; the device row is the app's product concept
 * (display name, last seen, browser kind), shown to the user as a device.
 */

import { createNodeIdAsync, InstantString } from '@epicenter/workspace';
import { storage } from '@wxt-dev/storage';
import type { TabManagerBrowser } from './tab-manager/extension';

/**
 * Compute the extension's node id and default device label.
 *
 * The node id is read from (or created in) `chrome.storage.local`. The
 * default name combines the browser brand and the host OS (e.g.
 * "Chrome on macOS") and is used to seed the device row when no row exists
 * yet; subsequent renames live on the row, not the node id.
 */
export async function createDeviceProfile() {
	const [nodeId, defaultName] = await Promise.all([
		createNodeIdAsync({
			storage: {
				getItem: (k) => storage.getItem<string>(`local:${k}`),
				setItem: async (k, v) => {
					await storage.setItem(`local:${k}`, v);
				},
			},
		}),
		generateDefaultDeviceName(),
	]);
	return {
		nodeId,
		defaultName,
	};
}

/**
 * Write the device record after IndexedDB loads. Preserves a previously-set
 * device name if one exists in the local doc; otherwise seeds with the
 * default label captured at boot.
 */
export async function registerDevice(
	tabManager: TabManagerBrowser,
	defaultName: string,
): Promise<void> {
	const id = tabManager.nodeId;
	const { data: existing, error } = tabManager.tables.devices.get(id);
	const existingName = !error && existing ? existing.name : null;
	tabManager.tables.devices.set({
		id,
		name: existingName ?? defaultName,
		lastSeen: InstantString.now(),
		browser: import.meta.env.BROWSER,
	});
}

const capitalize = (str: string) => str.charAt(0).toUpperCase() + str.slice(1);

/** Default device label like "Chrome on macOS". */
async function generateDefaultDeviceName(): Promise<string> {
	const browserName = capitalize(import.meta.env.BROWSER);
	const platformInfo = await browser.runtime.getPlatformInfo();
	const osName = (
		{
			mac: 'macOS',
			win: 'Windows',
			linux: 'Linux',
			cros: 'ChromeOS',
			android: 'Android',
			openbsd: 'OpenBSD',
			fuchsia: 'Fuchsia',
		} satisfies Record<Browser.runtime.PlatformInfo['os'], string>
	)[platformInfo.os];
	return `${browserName} on ${osName}`;
}
