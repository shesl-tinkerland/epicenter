/**
 * Machine auth API surface for CLI and daemons.
 *
 * `loginWithOob` runs the OOB OAuth dance once, fetches `/api/session` to derive
 * the local workspace identity, and persists a `PersistedAuth` cell to
 * `~/.epicenter/auth.json` (mode 0o600). `status` and `logout` read that
 * cell and reach the server through a regular `createOAuthAppAuth` client.
 * `createMachineAuthClient` is the daemon entry point: it loads the cell,
 * constructs the auth client, and never spawns an interactive launcher.
 *
 * Architectural note: `loginWithOob` deliberately bypasses
 * `createOAuthAppAuth`. The factory is for daemons (long-lived, refresh on
 * 401, network gate); login is a one-shot human action that fetches a grant,
 * calls `/api/session`, persists, and exits. Routing login through the factory
 * would double the round-trip count (the factory would call `/api/session`
 * internally, but the CLI also needs the email for "Signed in as ...").
 */

import { EPICENTER_API_URL } from '@epicenter/constants/apps';
import { EPICENTER_CLI_OAUTH_CLIENT_ID } from '@epicenter/constants/oauth';
import type { SubjectKeyring } from '@epicenter/encryption';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { createLogger, type Logger } from 'wellcrafted/logger';
import { Err, Ok, type Result } from 'wellcrafted/result';
import type { AuthClient } from '../auth-contract.js';
import { ApiSessionResponse, type PersistedAuth } from '../auth-types.js';
import {
	type AuthFetch,
	createOAuthAppAuth,
} from '../create-oauth-app-auth.js';
import {
	loadMachineTokens,
	type MachineAuthStorageError,
	saveMachineTokens,
} from './machine-tokens-store.js';
import { createOobOAuthLauncher } from './oob-launcher.js';

export const MachineAuthRequestError = defineErrors({
	RequestFailed: ({ cause }: { cause: unknown }) => ({
		message: `Auth transport request failed: ${extractErrorMessage(cause)}`,
		cause,
	}),
});
export type MachineAuthRequestError = InferErrors<
	typeof MachineAuthRequestError
>;

/**
 * Identity returned to the CLI for display. `user.email` is fetched from
 * `/api/session` and returned by value here so the CLI can print "Signed in as
 * <email>" without a second round-trip. `email` may be empty when the
 * machine is offline during `status`.
 */
export type MachineIdentity = {
	user: { id: string; email: string };
	keyring: SubjectKeyring;
};

type CommonConfig = {
	baseURL?: string;
	clientId?: string;
	redirectUri?: string;
	filePath?: string;
	fetch?: AuthFetch;
	log?: Logger;
	now?: () => number;
};

export type LoginWithOobConfig = CommonConfig & {
	print?: (line: string) => void;
	openBrowser?: (url: string) => Promise<void> | void;
	readCode?: () => Promise<string>;
};

export type LoginWithOobResult = { identity: MachineIdentity };

export type StatusResult =
	| { status: 'signedOut' }
	| { status: 'valid'; identity: MachineIdentity }
	| { status: 'unverified'; identity: MachineIdentity };

export type LogoutResult = { status: 'signedOut' } | { status: 'loggedOut' };

/**
 * Run the OOB OAuth dance, call `/api/session` for the local workspace identity,
 * persist `PersistedAuth`, and return the identity for the CLI to display.
 */
export async function loginWithOob({
	baseURL = EPICENTER_API_URL,
	clientId = EPICENTER_CLI_OAUTH_CLIENT_ID,
	redirectUri,
	filePath,
	fetch = globalThis.fetch.bind(globalThis),
	log = createLogger('machine-auth'),
	now = Date.now,
	print,
	openBrowser,
	readCode,
}: LoginWithOobConfig = {}): Promise<
	Result<LoginWithOobResult, MachineAuthRequestError | MachineAuthStorageError>
> {
	void log;
	const launcher = createOobOAuthLauncher({
		baseURL,
		clientId,
		redirectUri: redirectUri ?? `${baseURL}/auth/cli-callback`,
		fetch,
		now,
		...(print ? { print } : {}),
		...(openBrowser ? { openBrowser } : {}),
		...(readCode ? { readCode } : {}),
	});

	const grantResult = await launcher.startSignIn();
	if (grantResult.error) {
		return Err(
			MachineAuthRequestError.RequestFailed({ cause: grantResult.error }).error,
		);
	}
	if (!grantResult.data) {
		return Err(
			MachineAuthRequestError.RequestFailed({
				cause: new Error('OOB launcher returned no grant.'),
			}).error,
		);
	}
	const grant = grantResult.data;

	const sessionResult = await fetchApiSession({
		baseURL,
		accessToken: grant.accessToken,
		fetch,
	});
	if (sessionResult.error) return Err(sessionResult.error);
	const session = sessionResult.data;

	const cell: PersistedAuth = {
		grant,
		localIdentity: session.localIdentity,
	};
	const saved = await saveMachineTokens(
		cell,
		...(filePath ? [{ filePath }] : []),
	);
	if (saved.error) return Err(saved.error);

	return Ok({
		identity: {
			user: { id: session.user.id, email: session.user.email },
			keyring: session.localIdentity.keyring,
		},
	});
}

/**
 * Load the persisted cell and verify it by hitting `/api/session` through a
 * regular `createOAuthAppAuth` client (so refresh-on-401 fires automatically
 * and the same-subject guard wipes the cell on mismatch). Returns `unverified`
 * on network failures so the CLI can still report the cached identity.
 */
export async function status({
	baseURL = EPICENTER_API_URL,
	clientId = EPICENTER_CLI_OAUTH_CLIENT_ID,
	filePath,
	fetch = globalThis.fetch.bind(globalThis),
	log = createLogger('machine-auth'),
	now = Date.now,
}: CommonConfig = {}): Promise<
	Result<StatusResult, MachineAuthStorageError | MachineAuthRequestError>
> {
	const loaded = await loadMachineTokens({
		...(filePath ? { filePath } : {}),
		log,
	});
	if (loaded.error) return Err(loaded.error);
	if (!loaded.data) return Ok({ status: 'signedOut' as const });
	const cachedLocalIdentity = loaded.data.localIdentity;

	const client = await createMachineAuthClient({
		baseURL,
		clientId,
		filePath,
		fetch,
		log,
		now,
	});

	let response: Response;
	try {
		response = await client.fetch('/api/session');
	} catch (cause) {
		void cause;
		return Ok({
			status: 'unverified' as const,
			identity: {
				user: { id: cachedLocalIdentity.subject, email: '' },
				keyring: cachedLocalIdentity.keyring,
			},
		});
	}

	if (response.status === 200) {
		let body: unknown;
		try {
			body = await response.json();
		} catch (cause) {
			return Err(MachineAuthRequestError.RequestFailed({ cause }).error);
		}
		let session: ApiSessionResponse;
		try {
			session = ApiSessionResponse.assert(body);
		} catch (cause) {
			return Err(MachineAuthRequestError.RequestFailed({ cause }).error);
		}
		return Ok({
			status: 'valid' as const,
			identity: {
				user: { id: session.user.id, email: session.user.email },
				keyring: session.localIdentity.keyring,
			},
		});
	}

	// Network or auth failure. Cell may still be valid for local decrypt; the
	// underlying auth client will have wiped it on same-subject mismatch or
	// reauth-required already. Email is unknown without /api/session.
	return Ok({
		status: 'unverified' as const,
		identity: {
			user: { id: cachedLocalIdentity.subject, email: '' },
			keyring: cachedLocalIdentity.keyring,
		},
	});
}

/**
 * Revoke the persisted refresh token (best effort) and delete the file.
 * Uses `auth.signOut`, which calls `/auth/oauth2/revoke` and then
 * `persistedAuthStorage.set(null)`; revoke failures are swallowed inside
 * `createOAuthAppAuth` so the file is always cleared.
 */
export async function logout({
	baseURL = EPICENTER_API_URL,
	clientId = EPICENTER_CLI_OAUTH_CLIENT_ID,
	filePath,
	fetch = globalThis.fetch.bind(globalThis),
	log = createLogger('machine-auth'),
	now = Date.now,
}: CommonConfig = {}): Promise<
	Result<LogoutResult, MachineAuthStorageError | MachineAuthRequestError>
> {
	const loaded = await loadMachineTokens({
		...(filePath ? { filePath } : {}),
		log,
	});
	if (loaded.error) return Err(loaded.error);
	if (!loaded.data) return Ok({ status: 'signedOut' as const });

	const client = await createMachineAuthClient({
		baseURL,
		clientId,
		filePath,
		fetch,
		log,
		now,
	});
	await client.signOut();
	return Ok({ status: 'loggedOut' as const });
}

/**
 * Load the persisted cell and construct an `AuthClient` over it. Daemons
 * call this on boot; they never spawn an interactive sign-in launcher.
 */
export async function createMachineAuthClient({
	baseURL = EPICENTER_API_URL,
	clientId = EPICENTER_CLI_OAUTH_CLIENT_ID,
	filePath,
	fetch = globalThis.fetch.bind(globalThis),
	log = createLogger('machine-auth'),
	now = Date.now,
}: CommonConfig = {}): Promise<AuthClient> {
	void log;
	const loaded = await loadMachineTokens({
		...(filePath ? { filePath } : {}),
		log,
	});
	if (loaded.error) throw loaded.error;
	if (!loaded.data) {
		throw new Error(
			'[machine-auth] no saved session at ~/.epicenter/auth.json. ' +
				'Run `epicenter auth login` first.',
		);
	}
	let currentCell: PersistedAuth | null = loaded.data;
	return createOAuthAppAuth({
		baseURL,
		clientId,
		launcher: {
			// Daemons never sign in interactively; a human must run
			// `epicenter auth login` to refresh the persisted cell.
			startSignIn: async () => Ok(null),
		},
		persistedAuthStorage: {
			get: () => currentCell,
			set: async (next) => {
				const saved = await saveMachineTokens(
					next,
					...(filePath ? [{ filePath }] : []),
				);
				if (saved.error) throw saved.error;
				currentCell = next;
			},
		},
		fetch,
		now,
	});
}

async function fetchApiSession({
	baseURL,
	accessToken,
	fetch,
}: {
	baseURL: string;
	accessToken: string;
	fetch: AuthFetch;
}): Promise<Result<ApiSessionResponse, MachineAuthRequestError>> {
	let response: Response;
	try {
		response = await fetch(`${baseURL}/api/session`, {
			headers: { Authorization: `Bearer ${accessToken}` },
			credentials: 'omit',
		});
	} catch (cause) {
		return Err(MachineAuthRequestError.RequestFailed({ cause }).error);
	}
	if (response.status !== 200) {
		return Err(
			MachineAuthRequestError.RequestFailed({
				cause: new Error(`/api/session returned ${response.status}.`),
			}).error,
		);
	}
	let payload: unknown;
	try {
		payload = await response.json();
	} catch (cause) {
		return Err(MachineAuthRequestError.RequestFailed({ cause }).error);
	}
	try {
		return Ok(ApiSessionResponse.assert(payload));
	} catch (cause) {
		return Err(MachineAuthRequestError.RequestFailed({ cause }).error);
	}
}
