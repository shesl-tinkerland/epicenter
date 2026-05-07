import { requireSignedIn } from '@epicenter/auth';
import { createBearerAuth, waitForAuthState } from '@epicenter/auth-svelte';
import { APP_URLS } from '@epicenter/constants/vite';
import { getOrCreateInstallationIdAsync } from '@epicenter/workspace';
import { actionsToAiTools } from '@epicenter/workspace/ai';
import { storage } from '@wxt-dev/storage';
import { session } from '$lib/auth';
import type { DeviceId } from '$lib/workspace/definition';
import { openTabManager } from './extension';

await session.whenReady;

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
	throw new Error(
		'Cannot open Tab Manager workspace: signed-in auth required.',
	);
}
const userId = signedInState.identity.user.id;

/**
 * Resolve the peer descriptor before constructing the workspace. `id` and
 * `name` resolve in parallel. The chrome.storage read and the platform-info
 * lookup are independent.
 *
 * Presence publishes this descriptor synchronously at attach time, so the
 * factory awaits it before returning.
 */
const peer = await Promise.all([
	getOrCreateInstallationIdAsync<DeviceId>({
		getItem: (k) => storage.getItem<string>(`local:${k}`),
		setItem: async (k, v) => {
			await storage.setItem(`local:${k}`, v);
		},
	}),
	generateDefaultDeviceName(),
]).then(([id, name]) => ({
	id,
	name,
	platform: 'chrome-extension' as const,
}));

export const tabManager = await openTabManager({
	userId,
	peer,
	bearerToken: () => auth.bearerToken,
	encryptionKeys: () => requireSignedIn(auth).encryptionKeys,
});

/**
 * Register this browser installation as a device in the workspace.
 *
 * Upserts the device row. Preserves existing name if present, otherwise
 * uses the resolved default.
 */
async function registerDevice(): Promise<void> {
	const { id, name } = tabManager.peer;
	const { data: existing, error } = tabManager.tables.devices.get(id);
	const existingName = !error && existing ? existing.name : null;
	tabManager.tables.devices.set({
		id,
		name: existingName ?? name,
		lastSeen: new Date().toISOString(),
		browser: import.meta.env.BROWSER,
		_v: 1,
	});
}

void tabManager.idb.whenLoaded.then(registerDevice);

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

if (import.meta.hot) {
	import.meta.hot.dispose(() => {
		unsubscribeAuthState();
		auth[Symbol.dispose]();
		tabManager[Symbol.dispose]();
	});
}

/** AI tool representations for the tab-manager workspace. */
export const workspaceAiTools = actionsToAiTools(tabManager.actions);

/** Tool array type for use in TanStack AI generics. */
export type WorkspaceTools = typeof workspaceAiTools.tools;

// ─────────────────────────────────────────────────────────────────────────────
// Device naming
// ─────────────────────────────────────────────────────────────────────────────

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
