import {
	type AuthClient,
	type CreateOAuthAppAuthConfig,
	type CreateSameOriginCookieAuthConfig,
	createOAuthAppAuth as createCoreOAuthAppAuth,
	createSameOriginCookieAuth as createCoreSameOriginCookieAuth,
	type SyncAuthClient,
} from '@epicenter/auth';
import { createSubscriber } from 'svelte/reactivity';

// `createSession`/`SignedIn` bind a `SyncAuthClient` (produced by the reactive
// `createOAuthAppAuth` below) to a workspace lifecycle, so the whole reactive
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
	const subscribe = createSubscriber((update) => auth.onStateChange(update));
	return {
		...auth,
		get state() {
			subscribe();
			return auth.state;
		},
	} as T;
}

/**
 * Svelte 5 wrapper around `createOAuthAppAuth` (PKCE/bearer client for
 * cross-origin and native runtimes). Returns a `SyncAuthClient`, so it can be
 * passed to `createSession` for cloud sync.
 */
export function createOAuthAppAuth(
	config: CreateOAuthAppAuthConfig,
): SyncAuthClient {
	return reactiveAuthClient(createCoreOAuthAppAuth(config));
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
