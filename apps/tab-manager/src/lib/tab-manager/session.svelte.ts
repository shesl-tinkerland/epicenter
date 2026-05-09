/**
 * Session module for the tab-manager Chrome extension.
 *
 * Resolves the per-machine peer identity at module init (one top-level
 * await — chrome.storage and chrome.runtime are async by browser API
 * contract) and threads it into `createSession` via closure. The build
 * factory itself is sync: per-user identity comes from `auth`, the peer
 * is already in hand.
 *
 * The signed-in payload owns the workspace handle and every reactive
 * state factory that depends on it. Consumers read through
 * `getSignedInSession()` after the layout has gated on signed-in.
 *
 * @see {@link ../auth-client} bearer auth instance
 * @see {@link ./extension} sync `openTabManager` factory
 */

import { requireSignedIn } from '@epicenter/auth';
import { createSession, type InferSignedIn } from '@epicenter/svelte';
import { getOrCreateInstallationIdAsync } from '@epicenter/workspace';
import { actionsToAiTools } from '@epicenter/workspace/ai';
import { storage } from '@wxt-dev/storage';
import { createAiChatState } from '$lib/chat/chat-state.svelte';
import { auth } from '$lib/auth-client';
import { createBookmarkState } from '$lib/state/bookmark-state.svelte';
import { createSavedTabState } from '$lib/state/saved-tab-state.svelte';
import { createToolTrustState } from '$lib/state/tool-trust.svelte';
import { createUnifiedViewState } from '$lib/state/unified-view-state.svelte';
import type { DeviceId } from '$lib/workspace/definition';
import { openTabManager, type TabManager } from './extension';

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

export const session = createSession({
	auth,
	build: (identity) => {
		const userId = identity.user.id;
		const tabManager = openTabManager({
			userId,
			peer,
			bearerToken: () => auth.bearerToken,
			encryptionKeys: () => requireSignedIn(auth).encryptionKeys,
		});
		const workspaceAiTools = actionsToAiTools(tabManager.actions);
		const savedTabState = createSavedTabState({ tabManager });
		const bookmarkState = createBookmarkState({ tabManager });
		const toolTrustState = createToolTrustState({ tabManager });
		const aiChatState = createAiChatState({
			auth,
			tabManager,
			workspaceAiTools,
		});
		const unifiedViewState = createUnifiedViewState({
			bookmarkState,
			savedTabState,
		});

		void tabManager.idb.whenLoaded.then(() => registerDevice(tabManager));

		return {
			userId,
			tabManager,
			workspaceAiTools,
			savedTabState,
			bookmarkState,
			toolTrustState,
			aiChatState,
			unifiedViewState,
			[Symbol.dispose]() {
				aiChatState[Symbol.dispose]();
				toolTrustState[Symbol.dispose]();
				bookmarkState[Symbol.dispose]();
				savedTabState[Symbol.dispose]();
				tabManager[Symbol.dispose]();
			},
		};
	},
});

export type TabManagerSignedIn = InferSignedIn<typeof session>;
export type WorkspaceTools = TabManagerSignedIn['workspaceAiTools']['tools'];

if (import.meta.hot) {
	import.meta.hot.dispose(() => session[Symbol.dispose]());
}

/**
 * Returns the live signed-in session for this app.
 *
 * Throws if invoked outside the signed-in branch. The typical caller is a
 * component mounted under the layout's `{#if status === 'signed-in'}`
 * gate; the layout has already proven the precondition by the time the
 * component mounts. If a route or component slips past that gate, or a
 * callback fires after the workspace was disposed, the throw surfaces
 * the misuse loudly.
 *
 * Bind once at script init and dot-access fields:
 *
 * ```ts
 * const signedIn = getSignedInSession();
 * // then use signedIn.tabManager.X, signedIn.savedTabState.X, etc.
 * ```
 *
 * Do NOT inline the call into templates: that re-evaluates the helper
 * on every reactive update and interacts badly with teardown. Bind once
 * matches the codebase rule for reactive accessors (memory:
 * feedback_no_destructure_reactive.md).
 */
export function getSignedInSession(): TabManagerSignedIn {
	const c = session.current;
	if (c.status !== 'signed-in') {
		throw new Error(
			'[tab-manager] getSignedInSession() called outside the signed-in branch. ' +
				'This indicates a route or component mounted without the layout gate, ' +
				'or a callback firing after the workspace was disposed.',
		);
	}
	return c.signedIn;
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

/**
 * Register this browser installation as a device in the workspace.
 *
 * Upserts the device row. Preserves existing name if present, otherwise
 * uses the resolved default.
 */
async function registerDevice(tabManager: TabManager): Promise<void> {
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
