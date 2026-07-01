import { loadPersistedAuthStorage } from '@epicenter/auth';
import {
	EPICENTER_WHISPERING_OAUTH_CLIENT_ID,
	EPICENTER_WHISPERING_TAURI_OAUTH_REDIRECT_URI,
} from '@epicenter/constants/oauth-clients';
import { APP_URLS } from '@epicenter/constants/vite';
import { createHostedDeepLinkAuth } from '@epicenter/svelte/auth/tauri';
import { createLogger } from 'wellcrafted/logger';
import { instanceSetting } from '$lib/instance';
// This file is the Tauri impl, so it imports the non-null capability bag
// directly from the Tauri marker rather than through the `#platform/tauri`
// seam (which resolves to `null` under the web condition).
import { tauriOnly } from '$lib/tauri.tauri';
import type { PlatformAuth } from './types';

const log = createLogger('whispering/platform/auth');

// Keyed independently of `namespace` (which only shapes the localStorage key
// the web build and the pre-fix desktop build used): the OS credential store
// addresses secrets by service/account, not by a single string key.
//
// macOS scopes keychain ACLs to the app's code signature, so an ad-hoc-signed
// dev build touching an entry created by the notarized prod build (or the
// reverse) can trigger a Keychain permission prompt. If that bites, suffix
// this service string per channel (e.g. `whispering-dev`) rather than sharing
// one entry across signatures.
const KEYRING_SERVICE = 'whispering';
const KEYRING_ACCOUNT = 'auth-grant';

// The pre-fix desktop build persisted the grant under this `localStorage` key
// (`${namespace}.auth.persisted` from `createHostedDeepLinkAuth`'s old
// default) — a plain file on disk in the webview's data dir, exactly what
// this change moves off of. Migrated once below, then never read again.
const LEGACY_LOCAL_STORAGE_KEY = 'whispering.auth.persisted';

/**
 * Tolerant like the `localStorage` adapter's `get`: a keychain read failure
 * (locked keychain, platform error) reads as signed-out rather than crashing
 * app boot. The next sign-in re-establishes the grant.
 */
async function readGrant(): Promise<string | null> {
	const { data, error } = await tauriOnly.keyring.read(
		KEYRING_SERVICE,
		KEYRING_ACCOUNT,
	);
	if (error !== null) {
		log.warn(error);
		return null;
	}
	return data;
}

/**
 * Strict like the `localStorage` adapter's `set`: a grant that could not be
 * persisted must fail the sign-in or refresh that produced it, not silently
 * look saved.
 */
async function writeGrant(serialized: string | null): Promise<void> {
	const { error } = await tauriOnly.keyring.write(
		KEYRING_SERVICE,
		KEYRING_ACCOUNT,
		serialized,
	);
	if (error !== null) throw error;
}

/**
 * One-time migration off the pre-fix `localStorage` grant onto the keyring.
 * Only seeds the keyring when it's still empty (an existing keyring entry is
 * never overwritten), and only clears the legacy key once the value has
 * actually landed in the keyring, so a write failure leaves the legacy copy
 * in place for a retry on the next launch instead of losing the grant.
 *
 * Calls `tauriOnly.keyring.write` directly rather than through `writeGrant`:
 * migration is best-effort (log and retry next launch), not the "propagate
 * to the caller" contract `writeGrant` implements for `loadPersistedAuthStorage`.
 */
async function migrateLegacyLocalStorageGrant(): Promise<void> {
	const legacy = window.localStorage.getItem(LEGACY_LOCAL_STORAGE_KEY);
	if (legacy === null) return;

	const current = await readGrant();
	if (current !== null) {
		window.localStorage.removeItem(LEGACY_LOCAL_STORAGE_KEY);
		return;
	}

	const { error } = await tauriOnly.keyring.write(
		KEYRING_SERVICE,
		KEYRING_ACCOUNT,
		legacy,
	);
	if (error !== null) {
		log.warn(error);
		return;
	}
	window.localStorage.removeItem(LEGACY_LOCAL_STORAGE_KEY);
}

// Accepted multi-webview TOCTOU: every webview window evaluates this module,
// so two webviews can interleave the read-check-write above (or a
// refresh-driven `writeGrant`). The keyring is last-write-wins; the worst
// interleaving leaves one webview holding a stale grant, which surfaces as a
// single forced re-sign-in and self-heals. Not worth a cross-webview lock.
await migrateLegacyLocalStorageGrant();

export const auth: PlatformAuth = createHostedDeepLinkAuth({
	instanceSetting,
	namespace: 'whispering',
	clientId: EPICENTER_WHISPERING_OAUTH_CLIENT_ID,
	redirectUri: EPICENTER_WHISPERING_TAURI_OAUTH_REDIRECT_URI,
	api: APP_URLS.API,
	persistedAuthStorage: await loadPersistedAuthStorage({
		read: readGrant,
		write: writeGrant,
	}),
});

if (import.meta.hot) {
	import.meta.hot.dispose(() => auth[Symbol.dispose]());
}
