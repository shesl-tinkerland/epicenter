import { EPICENTER_API_URL } from '@epicenter/constants/apps';
import { encryptionKeysEqual } from '@epicenter/encryption';
import type { BetterAuthOptions } from 'better-auth';
import { createAuthClient, InferPlugin } from 'better-auth/client';
import type { customSession } from 'better-auth/plugins';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';
import type { AuthIdentity, AuthUser, BearerSession } from './auth-types.ts';
import {
	type BetterAuthSessionResponse,
	bearerSessionFromBetterAuthSessionResponse,
} from './contracts/auth-session.ts';

export const AuthError = defineErrors({
	InvalidCredentials: () => ({
		message: 'Invalid email or password.',
	}),
	SignInFailed: ({ cause }: { cause: unknown }) => ({
		message: `Failed to sign in: ${extractErrorMessage(cause)}`,
		cause,
	}),
	SignUpFailed: ({ cause }: { cause: unknown }) => ({
		message: `Failed to create account: ${extractErrorMessage(cause)}`,
		cause,
	}),
	SocialSignInFailed: ({ cause }: { cause: unknown }) => ({
		message: `Social sign-in failed: ${extractErrorMessage(cause)}`,
		cause,
	}),
	SignOutFailed: ({ cause }: { cause: unknown }) => ({
		message: `Failed to sign out: ${extractErrorMessage(cause)}`,
		cause,
	}),
});

export type AuthError = InferErrors<typeof AuthError>;

export type CreateBearerAuthConfig = {
	/** Resolved once at construction; recreate the client if the origin changes. */
	baseURL?: string;
	initialSession: BearerSession | null;
	saveSession: (value: BearerSession | null) => MaybePromise<void>;
};

export type CreateCookieAuthConfig = {
	/** Resolved once at construction; recreate the client if the origin changes. */
	baseURL?: string;
	initialIdentity?: AuthIdentity | null;
	saveIdentity?: (value: AuthIdentity | null) => MaybePromise<void>;
};

type MaybePromise<T> = T | Promise<T>;

export type AuthState =
	| { status: 'pending' }
	| { status: 'signed-in'; identity: AuthIdentity }
	| { status: 'signed-out' };

export type AuthStateChangeListener = (state: AuthState) => void;

type SetAuthState = (next: AuthState) => void;

export type AuthClient = {
	readonly state: AuthState;
	readonly bearerToken: string | null;
	onStateChange(fn: AuthStateChangeListener): () => void;
	signIn(input: {
		email: string;
		password: string;
	}): Promise<Result<undefined, AuthError>>;
	signUp(input: {
		email: string;
		password: string;
		name: string;
	}): Promise<Result<undefined, AuthError>>;
	signInWithIdToken(input: {
		provider: string;
		idToken: string;
		nonce: string;
	}): Promise<Result<undefined, AuthError>>;
	signInWithSocialRedirect(input: {
		provider: string;
		callbackURL: string;
	}): Promise<Result<undefined, AuthError>>;
	signOut(): Promise<Result<undefined, AuthError>>;
	fetch(input: Request | string | URL, init?: RequestInit): Promise<Response>;
	[Symbol.dispose](): void;
};

/**
 * Compile-time bridge for Better Auth's custom session type inference.
 *
 * `customSessionClient<typeof auth>()` is the canonical pattern but drags in
 * server-only types that client packages in a monorepo can't resolve.
 * `InferPlugin<T>()` sets the same `$InferServerPlugin` property without
 * requiring a fabricated auth shape.
 */
type EpicenterCustomSessionPlugin = ReturnType<
	typeof customSession<BetterAuthSessionResponse, BetterAuthOptions>
>;

/**
 * Create an auth client for runtimes that must carry their own bearer token.
 */
export function createBearerAuth({
	baseURL,
	initialSession,
	saveSession,
}: CreateBearerAuthConfig): AuthClient {
	let session: BearerSession | null = initialSession;

	function persistSession(next: BearerSession | null) {
		void Promise.resolve(saveSession(next)).catch((error) => {
			console.error('[auth] failed to save session:', error);
		});
	}

	function applyBearerSession(data: unknown, setState: SetAuthState) {
		let parsed: BearerSession | null;
		try {
			parsed = bearerSessionFromBetterAuthSessionResponse(data);
		} catch (error) {
			console.error('[auth] invalid Better Auth session response:', error);
			return;
		}
		const next: BearerSession | null =
			parsed === null
				? null
				: {
						token: session?.token ?? parsed.token,
						user: parsed.user,
						encryptionKeys: parsed.encryptionKeys,
					};
		const nextIdentity = identityFromSession(next);
		const nextState: AuthState =
			nextIdentity === null
				? { status: 'signed-out' }
				: { status: 'signed-in', identity: nextIdentity };
		if (sessionsEqual(session, next)) {
			setState(nextState);
			return;
		}
		session = next;
		setState(nextState);
		persistSession(next);
	}

	function clearBearerSession(setState: SetAuthState) {
		if (session === null) return;
		session = null;
		setState({ status: 'signed-out' });
		persistSession(null);
	}

	function rotateToken(newToken: string) {
		if (session === null || session.token === newToken) return;
		session = { ...session, token: newToken };
		persistSession(session);
	}

	return createAuthCore({
		baseURL,
		initialIdentity: identityFromSession(initialSession),
		fetchOptions: {
			auth: {
				type: 'Bearer',
				token: () => session?.token,
			},
			onSuccess: (context) => {
				const newToken = context.response.headers.get('set-auth-token');
				if (newToken) rotateToken(newToken);
			},
		},
		handleBetterAuthSession: applyBearerSession,
		clearCredential: clearBearerSession,
		fetch(input, init) {
			const headers = headersFromRequest(input, init);
			if (session !== null) {
				headers.set('Authorization', `Bearer ${session.token}`);
			} else {
				headers.delete('Authorization');
			}
			return fetch(input, { ...init, headers, credentials: 'omit' });
		},
		bearerToken: () => session?.token ?? null,
	});
}

/**
 * Create an auth client for apps that authenticate via the first-party cookie jar.
 */
export function createCookieAuth({
	baseURL,
	initialIdentity = null,
	saveIdentity,
}: CreateCookieAuthConfig): AuthClient {
	let lastPersisted: AuthIdentity | null = initialIdentity;

	function maybePersistIdentity(next: AuthIdentity | null) {
		if (identitiesEqual(lastPersisted, next)) return;
		lastPersisted = next;
		void Promise.resolve(saveIdentity?.(next)).catch((error) => {
			console.error('[auth] failed to save identity:', error);
		});
	}

	return createAuthCore({
		baseURL,
		initialIdentity,
		handleBetterAuthSession(data, setState) {
			let next: BearerSession | null;
			try {
				next = bearerSessionFromBetterAuthSessionResponse(data);
			} catch (error) {
				console.error('[auth] invalid Better Auth session response:', error);
				return;
			}
			const nextIdentity = identityFromSession(next);
			setState(
				nextIdentity === null
					? { status: 'signed-out' }
					: { status: 'signed-in', identity: nextIdentity },
			);
			maybePersistIdentity(nextIdentity);
		},
		clearCredential(setState) {
			setState({ status: 'signed-out' });
			maybePersistIdentity(null);
		},
		fetch(input, init) {
			const headers = headersFromRequest(input, init);
			headers.delete('Authorization');
			return fetch(input, { ...init, headers, credentials: 'include' });
		},
		bearerToken: () => null,
	});
}

type AuthCoreConfig = {
	baseURL?: string;
	initialIdentity: AuthIdentity | null;
	fetchOptions?: NonNullable<
		Parameters<typeof createAuthClient>[0]
	>['fetchOptions'];
	handleBetterAuthSession(data: unknown, setState: SetAuthState): void;
	clearCredential(setState: SetAuthState): void;
	fetch(input: Request | string | URL, init?: RequestInit): Promise<Response>;
	bearerToken(): string | null;
};

function createAuthCore({
	baseURL = EPICENTER_API_URL,
	initialIdentity,
	fetchOptions,
	handleBetterAuthSession,
	clearCredential,
	fetch,
	bearerToken,
}: AuthCoreConfig): AuthClient {
	let state: AuthState =
		initialIdentity === null
			? { status: 'pending' }
			: { status: 'signed-in', identity: initialIdentity };
	let hasDisposed = false;

	const stateChangeListeners = new Set<AuthStateChangeListener>();

	function setState(next: AuthState) {
		if (authStatesEqual(state, next)) return;
		state = next;
		for (const listener of stateChangeListeners) {
			try {
				listener(next);
			} catch (error) {
				console.error('[auth] subscriber threw:', error);
			}
		}
	}

	const betterAuthClient = createAuthClient({
		baseURL,
		basePath: '/auth',
		plugins: [InferPlugin<EpicenterCustomSessionPlugin>()],
		fetchOptions,
	});

	const unsubscribeBetterAuth = betterAuthClient.useSession.subscribe(
		(sessionState) => {
			if (sessionState.isPending) return;
			handleBetterAuthSession(sessionState.data, setState);
		},
	);

	return {
		get state() {
			return state;
		},
		get bearerToken() {
			return bearerToken();
		},
		onStateChange(fn) {
			stateChangeListeners.add(fn);
			return () => {
				stateChangeListeners.delete(fn);
			};
		},
		async signIn(input) {
			try {
				const { error } = await betterAuthClient.signIn.email(input);
				if (!error) return Ok(undefined);
				if (error.status === 401 || error.status === 403)
					return AuthError.InvalidCredentials();
				return AuthError.SignInFailed({ cause: error });
			} catch (error) {
				return AuthError.SignInFailed({ cause: error });
			}
		},

		async signUp(input) {
			try {
				const { error } = await betterAuthClient.signUp.email(input);
				if (error) return AuthError.SignUpFailed({ cause: error });
				return Ok(undefined);
			} catch (error) {
				return AuthError.SignUpFailed({ cause: error });
			}
		},

		async signInWithIdToken({ provider, idToken, nonce }) {
			try {
				const { error } = await betterAuthClient.signIn.social({
					provider,
					idToken: { token: idToken, nonce },
				});
				if (error) return AuthError.SocialSignInFailed({ cause: error });
				return Ok(undefined);
			} catch (error) {
				return AuthError.SocialSignInFailed({ cause: error });
			}
		},

		async signInWithSocialRedirect({ provider, callbackURL }) {
			try {
				await betterAuthClient.signIn.social({ provider, callbackURL });
				return Ok(undefined);
			} catch (error) {
				return AuthError.SocialSignInFailed({ cause: error });
			}
		},

		async signOut() {
			try {
				const { error } = await betterAuthClient.signOut();
				if (error) return AuthError.SignOutFailed({ cause: error });
				clearCredential(setState);
				return Ok(undefined);
			} catch (error) {
				return AuthError.SignOutFailed({ cause: error });
			}
		},

		fetch,

		[Symbol.dispose]() {
			if (hasDisposed) return;
			hasDisposed = true;
			unsubscribeBetterAuth();
			stateChangeListeners.clear();
		},
	};
}

export function waitForAuthState(
	auth: AuthClient,
	predicate: (state: AuthState) => boolean,
): Promise<AuthState> {
	if (predicate(auth.state)) return Promise.resolve(auth.state);

	return new Promise((resolve) => {
		const unsubscribe = auth.onStateChange((state) => {
			if (!predicate(state)) return;
			unsubscribe();
			resolve(state);
		});
	});
}

export function waitForAuthSettled(auth: AuthClient) {
	return waitForAuthState(auth, (state) => state.status !== 'pending');
}

function identityFromSession(value: BearerSession | null): AuthIdentity | null {
	if (value === null) return null;
	return {
		user: value.user,
		encryptionKeys: value.encryptionKeys,
	};
}

function authStatesEqual(left: AuthState, right: AuthState) {
	if (left.status !== right.status) return false;
	if (left.status !== 'signed-in' || right.status !== 'signed-in') return true;
	return identitiesEqual(left.identity, right.identity);
}

function identitiesEqual(
	left: AuthIdentity | null,
	right: AuthIdentity | null,
) {
	if (left === null || right === null) return left === right;
	return (
		usersEqual(left.user, right.user) &&
		encryptionKeysEqual(left.encryptionKeys, right.encryptionKeys)
	);
}

function sessionsEqual(
	left: BearerSession | null,
	right: BearerSession | null,
) {
	if (left === null || right === null) return left === right;
	return (
		left.token === right.token &&
		identitiesEqual(identityFromSession(left), identityFromSession(right))
	);
}

function headersFromRequest(input: Request | string | URL, init?: RequestInit) {
	const headers = new Headers(
		input instanceof Request ? input.headers : undefined,
	);
	new Headers(init?.headers).forEach((value, key) => {
		headers.set(key, value);
	});
	return headers;
}

function usersEqual(left: AuthUser, right: AuthUser) {
	return (
		left.id === right.id &&
		left.createdAt === right.createdAt &&
		left.updatedAt === right.updatedAt &&
		left.email === right.email &&
		left.emailVerified === right.emailVerified &&
		left.name === right.name &&
		left.image === right.image
	);
}
