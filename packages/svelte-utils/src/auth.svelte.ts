import {
	type AuthClient,
	type CreateAppAuthClientOptions,
	type CreateSameOriginCookieAuthConfig,
	createAppAuthClient as createCoreAppAuthClient,
	createSameOriginCookieAuth as createCoreSameOriginCookieAuth,
	createWebStoragePersistedAuthStorage,
	type Instance,
	type InstanceSetting,
	type SyncAuthClient,
} from '@epicenter/auth';
import { createBrowserOAuthLauncher } from '@epicenter/auth/oauth-launchers';
import { createSubscriber } from 'svelte/reactivity';

// The one composition shape (ADR-0088): boot-time doc selection plus
// reload-on-owner-change, extracted from Whispering's shipped wiring.
export { connectLocalFirst } from './connect-local-first.js';
export { reloadOnOwnerChange } from './reload-on-owner-change.js';
// `createSession`/`SignedIn` bind a `SyncAuthClient` (produced by the reactive
// `createAppAuthClient` below) to a workspace lifecycle, so the whole reactive
// auth + session story is one subpath. Re-exported here rather than from the
// package root, which stays pure workspace-data reactivity (`fromTable`, etc.).
export { createSession, type SignedIn } from './session.svelte.js';

/**
 * Make an auth client's `state` Svelte-reactive: spread the closure-bound
 * client and override `state` with a getter that calls `subscribe()` so reads
 * inside `$derived` / `$effect` track changes. Generic over the client type so
 * a `SyncAuthClient` stays a `SyncAuthClient` (the same transform applies to
 * either credential model; only the underlying client differs). The cast is
 * needed because a spread over a generic loses the precise type even though the
 * shape is preserved.
 */
function reactiveAuthClient<T extends AuthClient>(auth: T): T {
	const subscribeState = createSubscriber((update) =>
		auth.onStateChange(update),
	);
	const reactive = {
		...auth,
		get state() {
			subscribeState();
			return auth.state;
		},
	} as T;
	// The self-host token client also exposes a connection-verification channel
	// (pending / unreachable / rejected) that changes without touching `state`, so
	// give it its own subscriber. Clients without one (hosted OAuth, cookie) skip
	// this and keep the plain spread value (undefined).
	const source = auth.connection;
	if (source) {
		const subscribeConnection = createSubscriber((update) =>
			source.onChange(update),
		);
		reactive.connection = {
			get state() {
				subscribeConnection();
				return source.state;
			},
			onChange: source.onChange,
		};
	}
	return reactive;
}

/**
 * Svelte 5 wrapper around `createAppAuthClient`: the one client-side choke point
 * that turns a persisted `Instance` into a hosted-OAuth or self-host-token
 * client (the branch is internal). Returns a Svelte-reactive `SyncAuthClient`,
 * so it can be passed to `createSession` for cloud sync.
 */
export function createAppAuthClient(
	instance: Instance,
	options: CreateAppAuthClientOptions,
): SyncAuthClient {
	return reactiveAuthClient(createCoreAppAuthClient(instance, options));
}

/**
 * Svelte 5 wrapper around `createSameOriginCookieAuth` (cookie client for a
 * browser app the API serves from its own origin, e.g. the dashboard). Returns
 * a plain `AuthClient` (no `openWebSocket`); it cannot be passed to
 * `createSession`.
 */
export function createSameOriginCookieAuth(
	config: CreateSameOriginCookieAuthConfig,
): AuthClient {
	return reactiveAuthClient(createCoreSameOriginCookieAuth(config));
}

/** Options for {@link createHostedBrowserRedirectAuth}: only what varies per app. */
export type CreateHostedBrowserRedirectAuthOptions = {
	/** The app's persisted instance setting: hosted default or a self-host token. */
	instanceSetting: InstanceSetting;
	/** Namespace for the persisted-auth storage key (`<namespace>.auth.persisted`). */
	namespace: string;
	/** This app's hosted OAuth client id (used by both the client and the launcher). */
	clientId: string;
	/** The hosted API origin (e.g. `APP_URLS.API`): owns the issuer and the resource. */
	api: string;
	/** SvelteKit base path prepended to the callback, for a subpath deploy. Default `''`. */
	basePath?: string;
	/**
	 * Where the persisted grant lives. Defaults to `localStorage`. Pass
	 * `sessionStorage` (or an in-memory `Storage`) for an app whose web build
	 * decrypts high-value secrets in JS and wants a smaller XSS-persistence
	 * window (e.g. Whispering's vault, ADR-0079) — the grant then dies with the
	 * tab instead of surviving across sessions.
	 */
	persistedStorage?: Storage;
};

/**
 * Package the hosted browser-redirect OAuth convention every hosted web app
 * repeats: a `<namespace>.auth.persisted` grant (localStorage by default, override
 * via `persistedStorage`), a redirect launcher
 * built from the hosted constants (`${api}/auth` issuer, the `/auth/callback`
 * redirect, `api` as the resource, `sessionStorage` for the PKCE state), and the
 * persisted `Instance` fed to {@link createAppAuthClient}. Each app passes only
 * what varies: its namespace, OAuth client id, the hosted API origin, and an
 * optional SvelteKit base path. The result is a reactive `SyncAuthClient`, ready
 * for `createSession`.
 *
 * Redirect-only and hosted-only by construction: it owns no Tauri deep-link or
 * extension launcher and no self-host token branch. The self-host path still works
 * because `createAppAuthClient` reads it off the passed `instanceSetting` (a token
 * instance ignores the launcher); this factory only builds the browser launcher
 * the hosted branch needs. A Tauri app keeps its own deep-link launcher and uses
 * this for its web build alone (ADR-0078).
 */
export function createHostedBrowserRedirectAuth({
	instanceSetting,
	namespace,
	clientId,
	api,
	basePath = '',
	persistedStorage = window.localStorage,
}: CreateHostedBrowserRedirectAuthOptions): SyncAuthClient {
	return createAppAuthClient(instanceSetting.read(), {
		clientId,
		persistedAuthStorage: createWebStoragePersistedAuthStorage({
			key: `${namespace}.auth.persisted`,
			storage: persistedStorage,
		}),
		launcher: createBrowserOAuthLauncher({
			issuer: `${api}/auth`,
			clientId,
			redirectUri: `${window.location.origin}${basePath}/auth/callback`,
			resource: api,
			storage: window.sessionStorage,
		}),
	});
}
