import { API_ROUTES } from '@epicenter/constants/api-routes';
import { EPICENTER_API_URL } from '@epicenter/constants/apps';
import { BEARER_SUBPROTOCOL_PREFIX } from '@epicenter/constants/auth';
import { OAUTH_ROUTES } from '@epicenter/constants/oauth-routes';
import { keyringsEqual } from '@epicenter/encryption';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { createLogger, type Logger } from 'wellcrafted/logger';
import { Err, Ok, type Result } from 'wellcrafted/result';
import type { AuthClient, AuthState } from './auth-contract.js';
import { AuthError } from './auth-errors.js';
import {
	ApiSessionResponse,
	type OAuthTokenGrant,
	type PersistedAuth,
} from './auth-types.js';
import type { OAuthLauncher } from './oauth-launchers/contract.js';
import { parseOAuthTokenGrant } from './oauth-token-response.js';

/**
 * Storage adapter for the single `PersistedAuth` cell (grant + identity + keyring).
 * Two methods, no watch hook: cross-context sign-out propagates via the
 * server (next bearer-bearing call hits a revoked token and reauth-requires
 * organically). The server is the authority; brief cross-tab desync is
 * acceptable.
 */
export type PersistedAuthStorage = {
	get(): PersistedAuth | null;
	set(value: PersistedAuth | null): void | Promise<void>;
};

type AuthFetchInput = Request | string | URL;

/**
 * Fetch-compatible transport used by auth-owned HTTP calls.
 *
 * Consumers usually pass `auth.fetch` into API clients. Tests and machine auth
 * inject this shape so the auth runtime can exercise refresh, revoke, and
 * bearer attach without depending on global `fetch`.
 */
export type AuthFetch = (
	input: AuthFetchInput,
	init?: RequestInit,
) => Promise<Response>;

/**
 * Construction inputs for the framework-agnostic auth runtime.
 *
 * The caller supplies storage and a launcher. Auth core then owns the durable
 * session cell, refresh, `/api/session` verification, and bearer-bearing
 * transports. Launchers never write persisted identity, and app code never
 * reads raw tokens.
 */
export type CreateOAuthAppAuthConfig = {
	/**
	 * Epicenter API origin. Defaults to the production API and is used for
	 * relative API paths, OAuth refresh/revoke routes, and session verification.
	 */
	baseURL?: string;
	/**
	 * Public OAuth client id registered for this runtime.
	 */
	clientId: string;
	/**
	 * Durable storage for the single persisted auth cell.
	 */
	persistedAuthStorage: PersistedAuthStorage;
	/**
	 * Runtime-specific sign-in transport. It either returns a token grant or
	 * reports that control has moved to a later redirect/deep-link callback.
	 */
	launcher: OAuthLauncher;
	/**
	 * Fetch implementation for API session, refresh, revoke, and authenticated
	 * resource calls.
	 */
	fetch?: AuthFetch;
	/**
	 * WebSocket constructor. Tests and non-browser runtimes inject this because
	 * browsers do not allow request headers during WebSocket upgrades.
	 */
	WebSocket?: typeof WebSocket;
	/**
	 * Clock used for refresh-skew checks and refresh-token grant parsing.
	 */
	now?: () => number;
	/**
	 * Library logger for subscriber and refresh failures.
	 */
	log?: Logger;
};

const REFRESH_SKEW_MS = 60_000;

const AuthStateChangeError = defineErrors({
	SubscriberThrew: ({ cause }: { cause: unknown }) => ({
		message: `Auth state subscriber threw: ${extractErrorMessage(cause)}`,
		cause,
	}),
});

const ApiSessionRequestError = defineErrors({
	AuthRejected: ({ status }: { status: 401 | 403 }) => ({
		message: `API session rejected the current token with ${status}.`,
		status,
	}),
	Unavailable: ({ cause }: { cause: unknown }) => ({
		message: `Could not verify API session: ${extractErrorMessage(cause)}`,
		cause,
	}),
});
type ApiSessionRequestError = InferErrors<typeof ApiSessionRequestError>;

type NetworkAccess = 'unverified' | 'verified' | 'paused';

type RuntimeAuthState =
	| { status: 'signed-out' }
	| {
			status: 'signed-in';
			persistedAuth: PersistedAuth;
			networkAccess: NetworkAccess;
	  };

type RefreshFlight = {
	persistedAuth: PersistedAuth;
	promise: Promise<boolean>;
};

type IdentityVerificationFlight = {
	persistedAuth: PersistedAuth;
	promise: Promise<ApiSessionRequestResult>;
};

type ApiSessionRequestResult = Result<
	ApiSessionResponse,
	ApiSessionRequestError
>;

/**
 * Create the app-side auth boundary for browser, extension, and machine clients.
 *
 * Use this once per runtime around one persisted auth record. The returned
 * client exposes capabilities (`fetch`, `openWebSocket`) instead of raw tokens:
 * it refreshes grants, verifies `/api/session` before attaching a bearer, and
 * keeps the cached `ownerId` and `keyring` available when network auth pauses.
 * That preserves the local-first invariant: offline workspace boot can continue,
 * but server access fails closed until the current persisted auth has been
 * verified by the API.
 */
export function createOAuthAppAuth({
	baseURL = EPICENTER_API_URL,
	clientId,
	persistedAuthStorage,
	launcher,
	fetch: fetchImpl = globalThis.fetch.bind(globalThis),
	WebSocket: WebSocketImpl = globalThis.WebSocket,
	now = Date.now,
	log = createLogger('auth/oauth-app'),
}: CreateOAuthAppAuthConfig): AuthClient {
	const authSession = createAuthSessionRuntime({
		initialPersistedAuth: persistedAuthStorage.get(),
		persistedAuthStorage,
		log,
	});
	let refreshFlight: RefreshFlight | null = null;
	let identityVerificationFlight: IdentityVerificationFlight | null = null;
	let signInFlight: Promise<Result<undefined, AuthError>> | null = null;
	let signInGeneration = 0;

	function beginSignInGeneration() {
		signInGeneration += 1;
		return signInGeneration;
	}

	function isCurrentSignIn(generation: number) {
		return signInGeneration === generation;
	}

	function cancelInFlightSignIn() {
		signInGeneration += 1;
		signInFlight = null;
	}

	async function clearAuthSession() {
		refreshFlight = null;
		identityVerificationFlight = null;
		await authSession.clear();
	}

	async function clearPersistedAuth() {
		cancelInFlightSignIn();
		await clearAuthSession();
	}

	async function refreshGrant(force: boolean): Promise<boolean> {
		const startedFrom = authSession.persistedAuth;
		if (startedFrom === null || authSession.networkAuthPaused) return false;
		if (
			!force &&
			startedFrom.grant.accessTokenExpiresAt > now() + REFRESH_SKEW_MS
		) {
			return true;
		}
		if (refreshFlight?.persistedAuth === startedFrom) {
			return refreshFlight.promise;
		}

		const promise = (async () => {
			try {
				const grant = await refreshOAuthTokenWithEndpoint({
					baseURL,
					clientId,
					grant: startedFrom.grant,
					fetch: fetchImpl,
					now,
				});
				if (authSession.persistedAuth !== startedFrom) return false;
				const next = {
					grant,
					userId: startedFrom.userId,
					ownerId: startedFrom.ownerId,
					keyring: startedFrom.keyring,
				} satisfies PersistedAuth;
				await authSession.write(next);
				if (authSession.persistedAuth !== startedFrom) return false;
				authSession.installUnverified(next);
				return true;
			} catch (cause) {
				if (authSession.persistedAuth === startedFrom) {
					authSession.pauseNetworkAuth();
					log.error(AuthError.RefreshGrantFailed({ cause }));
				}
				return false;
			} finally {
				if (refreshFlight?.persistedAuth === startedFrom) {
					refreshFlight = null;
				}
			}
		})();
		refreshFlight = { persistedAuth: startedFrom, promise };

		return promise;
	}

	async function requestApiSession(
		grant: OAuthTokenGrant,
	): Promise<ApiSessionRequestResult> {
		let response: Response;
		try {
			response = await fetchImpl(API_ROUTES.session.url(baseURL), {
				headers: { Authorization: `Bearer ${grant.accessToken}` },
				credentials: 'omit',
			});
		} catch (cause) {
			return ApiSessionRequestError.Unavailable({ cause });
		}
		if (!response.ok) {
			if (response.status === 401 || response.status === 403) {
				return ApiSessionRequestError.AuthRejected({ status: response.status });
			}
			return ApiSessionRequestError.Unavailable({
				cause: new Error(
					`${API_ROUTES.session.pattern} failed with ${response.status}.`,
				),
			});
		}
		try {
			return Ok(ApiSessionResponse.assert(await response.json()));
		} catch (cause) {
			return ApiSessionRequestError.Unavailable({ cause });
		}
	}

	/**
	 * Verify `/api/session` against the current persisted auth. Marks it
	 * verified; rewrites the persisted cell only when the keyring actually
	 * changed. Wipes storage on same-owner-guard mismatch (different
	 * `ownerId`). Single-flight: concurrent callers for the same persisted
	 * auth share the in-flight promise.
	 */
	async function verifyPersistedAuthForNetwork(
		startedFrom: PersistedAuth,
	): Promise<ApiSessionRequestResult> {
		if (identityVerificationFlight?.persistedAuth === startedFrom) {
			return identityVerificationFlight.promise;
		}
		const promise = (async (): Promise<ApiSessionRequestResult> => {
			const { data: session, error } = await requestApiSession(
				startedFrom.grant,
			);
			if (error) {
				if (
					error.name === 'AuthRejected' &&
					authSession.persistedAuth === startedFrom
				) {
					authSession.pauseNetworkAuth();
				}
				return Err(error);
			}
			const current = authSession.persistedAuth;
			if (current !== startedFrom) return Ok(session);

			if (current.ownerId !== session.ownerId) {
				await clearPersistedAuth();
				return Ok(session);
			}

			if (!keyringsEqual(current.keyring, session.keyring)) {
				const next = {
					grant: current.grant,
					userId: session.user.id,
					ownerId: session.ownerId,
					keyring: session.keyring,
				} satisfies PersistedAuth;
				await authSession.write(next);
				if (authSession.persistedAuth !== startedFrom) return Ok(session);
				authSession.installVerified(next);
				return Ok(session);
			}
			authSession.installVerified(current);
			return Ok(session);
		})().finally(() => {
			if (identityVerificationFlight?.persistedAuth === startedFrom) {
				identityVerificationFlight = null;
			}
		});
		identityVerificationFlight = { persistedAuth: startedFrom, promise };

		return promise;
	}

	/**
	 * Network gate. Returns the access token to attach to a bearer-bearing
	 * request, or `null` if no bearer should be attached.
	 *
	 * Refuses to attach unless `/api/session` has confirmed the current persisted
	 * auth in this runtime. Cold boot online: refresh grant if
	 * stale, call `/api/session`, then attach. Offline: fails closed; local
	 * workspace decrypt continues via the cached `keyring`.
	 */
	async function bearerForNetwork(force: boolean): Promise<string | null> {
		if (authSession.persistedAuth === null || authSession.networkAuthPaused) {
			return null;
		}
		const refreshed = await refreshGrant(force);
		const refreshedPersistedAuth = authSession.persistedAuth;
		if (
			!refreshed ||
			refreshedPersistedAuth === null ||
			authSession.networkAuthPaused
		) {
			return null;
		}
		let verifiedPersistedAuth = authSession.verifiedPersistedAuth;
		if (verifiedPersistedAuth === null) {
			const verification = await verifyPersistedAuthForNetwork(
				refreshedPersistedAuth,
			);
			if (verification.error) return null;
			verifiedPersistedAuth = authSession.verifiedPersistedAuth;
			if (verifiedPersistedAuth === null) return null;
		}
		return verifiedPersistedAuth.grant.accessToken;
	}

	async function fetchWithAuth(
		input: AuthFetchInput,
		init: RequestInit | undefined,
		forceRefresh: boolean,
	) {
		const headers = headersFromRequest(input, init);
		const accessToken = await bearerForNetwork(forceRefresh);
		if (accessToken) {
			headers.set('Authorization', `Bearer ${accessToken}`);
		} else {
			headers.delete('Authorization');
		}
		let normalizedInput: AuthFetchInput = input;
		if (input instanceof Request) {
			normalizedInput = input.clone() as Request;
		} else if (typeof input === 'string' && input.startsWith('/')) {
			normalizedInput = new URL(input, baseURL).toString();
		}
		return fetchImpl(normalizedInput, {
			...init,
			headers,
			credentials: 'omit',
		});
	}

	async function completeSignInWithGrant(
		grant: OAuthTokenGrant,
		generation: number,
	): Promise<Result<undefined, AuthError>> {
		if (!isCurrentSignIn(generation)) return Ok(undefined);
		const previous = authSession.persistedAuth;
		const { data: session, error } = await requestApiSession(grant);
		if (error) {
			return AuthError.StartSignInFailed({ cause: error });
		}
		if (!isCurrentSignIn(generation)) return Ok(undefined);
		if (previous !== null && previous.ownerId !== session.ownerId) {
			await clearAuthSession();
			if (!isCurrentSignIn(generation)) return Ok(undefined);
		}
		const next = {
			grant,
			userId: session.user.id,
			ownerId: session.ownerId,
			keyring: session.keyring,
		} satisfies PersistedAuth;
		await authSession.write(next);
		if (!isCurrentSignIn(generation)) return Ok(undefined);
		authSession.installVerified(next);
		return Ok(undefined);
	}

	return {
		get state() {
			return authSession.state;
		},
		baseURL,
		onStateChange(fn) {
			return authSession.onStateChange(fn);
		},
		async startSignIn() {
			if (signInFlight !== null) return signInFlight;
			const generation = beginSignInGeneration();
			const promise = (async () => {
				try {
					const result = await launcher.startSignIn();
					if (!isCurrentSignIn(generation)) {
						return Ok(undefined);
					}
					if (result.error) {
						return AuthError.StartSignInFailed({ cause: result.error });
					}
					const launchResult = result.data;
					switch (launchResult?.status) {
						case 'launched':
							return Ok(undefined);
						case 'completed':
							return completeSignInWithGrant(launchResult.grant, generation);
					}
					return AuthError.StartSignInFailed({
						cause: new Error('OAuth launcher returned no launch result.'),
					});
				} catch (cause) {
					if (!isCurrentSignIn(generation)) {
						return Ok(undefined);
					}
					return AuthError.StartSignInFailed({ cause });
				}
			})().finally(() => {
				if (signInFlight === promise) signInFlight = null;
			});
			signInFlight = promise;
			return promise;
		},
		async signOut() {
			try {
				const refreshTokenToRevoke =
					authSession.persistedAuth?.grant.refreshToken;
				await clearPersistedAuth();
				if (refreshTokenToRevoke) {
					void revokeOAuthRefreshTokenWithEndpoint({
						baseURL,
						clientId,
						refreshToken: refreshTokenToRevoke,
						fetch: fetchImpl,
					}).catch(() => undefined);
				}
				return Ok(undefined);
			} catch (cause) {
				return AuthError.SignOutFailed({ cause });
			}
		},
		async fetch(input, init?: RequestInit) {
			const response = await fetchWithAuth(input, init, false);
			if (response.status !== 401) return response;
			const refreshed = await refreshGrant(true);
			if (!refreshed) return response;
			const retryResponse = await fetchWithAuth(input, init, false);
			if (retryResponse.status === 401) {
				authSession.pauseNetworkAuth();
			}
			return retryResponse;
		},
		async openWebSocket(url, protocols = []) {
			const accessToken = await bearerForNetwork(false);
			const authProtocols = accessToken
				? [...protocols, `${BEARER_SUBPROTOCOL_PREFIX}${accessToken}`]
				: protocols;
			return new WebSocketImpl(String(url), authProtocols);
		},
		[Symbol.dispose]() {
			authSession.dispose();
		},
	};
}

/**
 * Owns the in-memory projection of the persisted auth cell.
 *
 * This is a one-caller helper, but it earns the boundary by keeping the storage
 * write queue, listener fan-out, and public state projection in one small
 * runtime object. OAuth flow code mutates the runtime through verbs instead of
 * rewriting state shapes directly.
 */
function createAuthSessionRuntime({
	initialPersistedAuth,
	persistedAuthStorage,
	log,
}: {
	initialPersistedAuth: PersistedAuth | null;
	persistedAuthStorage: PersistedAuthStorage;
	log: Logger;
}) {
	let runtimeState: RuntimeAuthState =
		initialPersistedAuth === null
			? { status: 'signed-out' }
			: {
					status: 'signed-in',
					persistedAuth: initialPersistedAuth,
					networkAccess: 'unverified',
				};
	let publicState = publicStateFromRuntime(runtimeState);
	let storageWriteQueue: Promise<void> = Promise.resolve();
	const stateChangeListeners = new Set<(state: AuthState) => void>();

	function publishState() {
		const next = publicStateFromRuntime(runtimeState);
		if (authStatesEqual(publicState, next)) return;
		publicState = next;
		for (const listener of stateChangeListeners) {
			try {
				listener(next);
			} catch (error) {
				log.error(AuthStateChangeError.SubscriberThrew({ cause: error }));
			}
		}
	}

	async function write(value: PersistedAuth | null) {
		const pendingWrite = storageWriteQueue.then(() =>
			persistedAuthStorage.set(value),
		);
		storageWriteQueue = pendingWrite.catch(() => undefined);
		await pendingWrite;
	}

	return {
		get state() {
			return publicState;
		},
		get persistedAuth(): PersistedAuth | null {
			return runtimeState.status === 'signed-out'
				? null
				: runtimeState.persistedAuth;
		},
		get networkAuthPaused() {
			return (
				runtimeState.status === 'signed-in' &&
				runtimeState.networkAccess === 'paused'
			);
		},
		get verifiedPersistedAuth(): PersistedAuth | null {
			if (runtimeState.status === 'signed-out') return null;
			if (runtimeState.networkAccess !== 'verified') return null;
			return runtimeState.persistedAuth;
		},
		onStateChange(fn: (state: AuthState) => void) {
			stateChangeListeners.add(fn);
			return () => {
				stateChangeListeners.delete(fn);
			};
		},
		installUnverified(persistedAuth: PersistedAuth) {
			runtimeState = {
				status: 'signed-in',
				persistedAuth,
				networkAccess: 'unverified',
			};
			publishState();
		},
		installVerified(persistedAuth: PersistedAuth) {
			runtimeState = {
				status: 'signed-in',
				persistedAuth,
				networkAccess: 'verified',
			};
			publishState();
		},
		pauseNetworkAuth() {
			if (runtimeState.status === 'signed-out') return;
			runtimeState = {
				...runtimeState,
				networkAccess: 'paused',
			};
			publishState();
		},
		async write(value: PersistedAuth | null) {
			await write(value);
		},
		async clear() {
			runtimeState = { status: 'signed-out' };
			publishState();
			await write(null);
		},
		dispose() {
			stateChangeListeners.clear();
		},
	};
}

function publicStateFromRuntime(runtimeState: RuntimeAuthState): AuthState {
	if (runtimeState.status === 'signed-out') return { status: 'signed-out' };
	if (runtimeState.networkAccess === 'paused') {
		return {
			status: 'reauth-required',
			ownerId: runtimeState.persistedAuth.ownerId,
			keyring: runtimeState.persistedAuth.keyring,
		};
	}
	return {
		status: 'signed-in',
		ownerId: runtimeState.persistedAuth.ownerId,
		keyring: runtimeState.persistedAuth.keyring,
	};
}

function authStatesEqual(left: AuthState, right: AuthState) {
	if (left.status !== right.status) return false;
	if (left.status === 'signed-out') return true;
	if (right.status === 'signed-out') return false;
	return (
		left.ownerId === right.ownerId && keyringsEqual(left.keyring, right.keyring)
	);
}

/**
 * Merge Request headers with RequestInit headers using Fetch's own normalization.
 *
 * This stays as a helper because `HeadersInit` accepts several runtime shapes,
 * including iterable entries that TypeScript does not always model directly.
 */
function headersFromRequest(input: Request | string | URL, init?: RequestInit) {
	const headers = new Headers(
		input instanceof Request ? input.headers : undefined,
	);
	const source = init?.headers;
	if (!source) return headers;

	new Headers(source).forEach((value, key) => {
		headers.set(key, value);
	});
	return headers;
}

async function refreshOAuthTokenWithEndpoint({
	baseURL,
	clientId,
	grant,
	fetch,
	now,
}: {
	baseURL: string;
	clientId: string;
	grant: OAuthTokenGrant;
	fetch: AuthFetch;
	now: () => number;
}): Promise<OAuthTokenGrant> {
	const body = new URLSearchParams({
		grant_type: 'refresh_token',
		refresh_token: grant.refreshToken,
		client_id: clientId,
		resource: baseURL,
	});
	const response = await fetch(OAUTH_ROUTES.token.url(baseURL), {
		method: 'POST',
		body,
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		credentials: 'omit',
	});
	if (!response.ok) {
		throw new Error(`OAuth refresh failed with ${response.status}.`);
	}
	const data = await response.json();
	const { data: parsed, error } = parseOAuthTokenGrant(data, {
		now,
		fallbackRefreshToken: grant.refreshToken,
	});
	if (error) {
		throw new Error(
			`OAuth refresh produced an invalid grant: ${error.message}`,
			{ cause: error },
		);
	}
	return parsed;
}

async function revokeOAuthRefreshTokenWithEndpoint({
	baseURL,
	clientId,
	refreshToken,
	fetch,
}: {
	baseURL: string;
	clientId: string;
	refreshToken: string;
	fetch: AuthFetch;
}) {
	const body = new URLSearchParams({
		client_id: clientId,
		token: refreshToken,
		token_type_hint: 'refresh_token',
	});
	const response = await fetch(OAUTH_ROUTES.revoke.url(baseURL), {
		method: 'POST',
		body,
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		credentials: 'omit',
	});
	if (!response.ok) {
		throw new Error(`OAuth revoke failed with ${response.status}.`);
	}
}
