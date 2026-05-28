/**
 * Machine auth API surface for CLI and daemons.
 *
 * `loginWithOob` runs the OOB OAuth dance once, fetches `/api/session` to derive
 * the local workspace identity, and persists a `PersistedAuth` cell to the
 * API-target-specific machine auth file (mode 0o600). `status` and `logout`
 * read that cell and reach the server through a regular `createOAuthAppAuth`
 * client. `createMachineAuthClient` is the daemon entry point: it loads the
 * cell, constructs the auth client, and never spawns an interactive launcher.
 *
 * Architectural note: `loginWithOob` deliberately bypasses
 * `createOAuthAppAuth`. The factory is for daemons (long-lived, refresh on
 * 401, network gate); login is a one-shot human action that fetches a grant,
 * calls `/api/session`, persists, and exits. Routing login through the factory
 * would double the round-trip count (the factory would call `/api/session`
 * internally, but the CLI also needs the email for "Signed in as ...").
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { API_ROUTES } from '@epicenter/constants/api-routes';
import { EPICENTER_API_URL } from '@epicenter/constants/apps';
import { EPICENTER_CLI_OAUTH_CLIENT_ID } from '@epicenter/constants/oauth';
import type { Keyring } from '@epicenter/encryption';
import envPaths from 'env-paths';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { createLogger, type Logger } from 'wellcrafted/logger';
import { Err, Ok, type Result, tryAsync } from 'wellcrafted/result';
import type { AuthClient } from '../auth-contract.js';
import {
	ApiSessionResponse,
	PersistedAuth,
	type UserId,
} from '../auth-types.js';
import {
	type AuthFetch,
	createOAuthAppAuth,
} from '../create-oauth-app-auth.js';
import { createOobOAuthLauncher } from './oob-launcher.js';

/**
 * Auth's per-user data directory. Honors `EPICENTER_DATA_DIR` first, then
 * falls back to the env-paths platform data directory (e.g.
 * `~/Library/Application Support/epicenter` on macOS,
 * `~/.local/share/epicenter` on Linux). Resolved once at module load:
 * production env vars don't change mid-process.
 */
const DEFAULT_DATA_DIR =
	process.env.EPICENTER_DATA_DIR ?? envPaths('epicenter', { suffix: '' }).data;

/**
 * The on-disk machine auth file for a given API target.
 *
 * One file per API target under the platform data directory, in an `auth/`
 * subdirectory: `<dataDir>/auth/<host>.json` with `:` in the host replaced
 * by `_`. Prod resolves to `<dataDir>/auth/api.epicenter.so.json`; `cli:local`
 * (`EPICENTER_API_URL=http://localhost:8787`) resolves to
 * `<dataDir>/auth/localhost_8787.json`. Different targets cannot trample
 * each other.
 *
 * `dataDir` defaults to {@link DEFAULT_DATA_DIR} and exists as an override
 * for tests; production callers should never pass it.
 */
export function machineAuthFilePath({
	baseURL = EPICENTER_API_URL,
	dataDir = DEFAULT_DATA_DIR,
}: {
	baseURL?: string;
	dataDir?: string;
} = {}): string {
	let host: string;
	try {
		host = new URL(baseURL).host;
	} catch (cause) {
		throw new Error(`Invalid Epicenter API URL: ${baseURL}`, { cause });
	}
	return path.join(dataDir, 'auth', `${host.replaceAll(':', '_')}.json`);
}

export const MachineAuthRequestError = defineErrors({
	RequestFailed: ({ cause }: { cause: unknown }) => ({
		message: `Auth transport request failed: ${extractErrorMessage(cause)}`,
		cause,
	}),
});
export type MachineAuthRequestError = InferErrors<
	typeof MachineAuthRequestError
>;

export const MachineAuthStorageError = defineErrors({
	StorageFailed: ({ cause }: { cause: unknown }) => ({
		message: `Could not access machine auth storage: ${extractErrorMessage(cause)}`,
		cause,
	}),
	PermissionsTooOpen: ({
		filePath,
		mode,
	}: {
		filePath: string;
		mode: number;
	}) => ({
		message: `Refusing to load ${filePath}: permissions ${mode.toString(8)} are too permissive. Run: chmod 600 ${filePath}`,
		filePath,
		mode,
	}),
	NoSavedSession: ({
		filePath,
		baseURL,
	}: {
		filePath: string;
		baseURL: string;
	}) => ({
		message: `[machine-auth] no saved session at ${filePath}. Run \`epicenter auth login\` against ${baseURL} first.`,
		filePath,
		baseURL,
	}),
});
export type MachineAuthStorageError = InferErrors<
	typeof MachineAuthStorageError
>;

/**
 * Read the persisted auth cell at `filePath`. Private to this module: the
 * orchestration functions below resolve the path and call through to here.
 *
 * - Missing file -> `Ok(null)` (signed-out).
 * - Corrupt JSON or shape mismatch -> log warning, `Ok(null)`.
 * - Permissions wider than 0o600 on a regular file -> refuse with a clear
 *   chmod hint.
 */
async function loadMachineTokens({
	filePath,
	log,
}: {
	filePath: string;
	log: Logger;
}): Promise<Result<PersistedAuth | null, MachineAuthStorageError>> {
	const stat = await tryAsync({
		try: () => fs.stat(filePath),
		catch: (cause) => MachineAuthStorageError.StorageFailed({ cause }),
	});
	if (stat.error) {
		const cause = stat.error.cause as NodeJS.ErrnoException | undefined;
		if (cause?.code === 'ENOENT') return Ok(null);
		return Err(stat.error);
	}
	if (process.platform !== 'win32') {
		const mode = stat.data.mode & 0o777;
		if ((mode & 0o077) !== 0) {
			return Err(
				MachineAuthStorageError.PermissionsTooOpen({ filePath, mode }).error,
			);
		}
	}

	const read = await tryAsync({
		try: () => fs.readFile(filePath, 'utf-8'),
		catch: (cause) => MachineAuthStorageError.StorageFailed({ cause }),
	});
	if (read.error) return Err(read.error);

	try {
		return Ok(PersistedAuth.assert(JSON.parse(read.data)));
	} catch (cause) {
		log.warn(
			MachineAuthStorageError.StorageFailed({
				cause: new Error(
					`Discarding corrupted ${filePath}: ${extractErrorMessage(cause)}`,
					{ cause },
				),
			}),
		);
		return Ok(null);
	}
}

/**
 * Write or remove the persisted auth cell. Atomic via `.tmp` + rename so a
 * crash mid-write never leaves a half-written file. Private to this module.
 */
async function saveMachineTokens(
	value: PersistedAuth | null,
	{ filePath }: { filePath: string },
): Promise<Result<undefined, MachineAuthStorageError>> {
	return tryAsync({
		try: async (): Promise<undefined> => {
			if (value === null) {
				try {
					await fs.unlink(filePath);
				} catch (cause) {
					const code = (cause as NodeJS.ErrnoException | undefined)?.code;
					if (code !== 'ENOENT') throw cause;
				}
				return undefined;
			}
			await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
			const tmp = `${filePath}.tmp`;
			await fs.writeFile(tmp, JSON.stringify(PersistedAuth.assert(value)), {
				mode: 0o600,
			});
			await fs.rename(tmp, filePath);
			return undefined;
		},
		catch: (cause) => MachineAuthStorageError.StorageFailed({ cause }),
	});
}

/**
 * Identity returned to the CLI for display. `user.email` is fetched from
 * `/api/session` and returned by value here so the CLI can print "Signed in as
 * <email>" without a second round-trip. `email` may be empty when the
 * machine is offline during `status`.
 */
export type MachineIdentity = {
	user: { id: UserId; email: string };
	keyring: Keyring;
};

type CommonConfig = {
	baseURL?: string;
	clientId?: string;
	filePath?: string;
	fetch?: AuthFetch;
	log?: Logger;
	now?: () => number;
};

export type LoginWithOobConfig = CommonConfig & {
	/**
	 * Optional OOB callback override for tests and local trusted-client fixtures.
	 * Production login uses the callback derived from `baseURL`.
	 */
	redirectUri?: string;
	/**
	 * Output sink for the URL and success messages printed by the CLI.
	 */
	print?: (line: string) => void;
	/**
	 * Best-effort browser opener used by the OOB launcher.
	 */
	openBrowser?: (url: string) => Promise<void> | void;
	/**
	 * Reads the one-time code pasted from the hosted CLI callback page.
	 */
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
	now = Date.now,
	print,
	openBrowser,
	readCode,
}: LoginWithOobConfig = {}): Promise<
	Result<LoginWithOobResult, MachineAuthRequestError | MachineAuthStorageError>
> {
	const authFilePath = filePath ?? machineAuthFilePath({ baseURL });
	const launcher = createOobOAuthLauncher({
		baseURL,
		clientId,
		fetch,
		now,
		...(redirectUri ? { redirectUri } : {}),
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
	const launchResult = grantResult.data;
	if (launchResult?.status !== 'completed') {
		return Err(
			MachineAuthRequestError.RequestFailed({
				cause: new Error('OOB launcher returned no grant.'),
			}).error,
		);
	}
	const grant = launchResult.grant;

	const sessionResult = await fetchApiSession(
		baseURL,
		grant.accessToken,
		fetch,
	);
	if (sessionResult.error) return Err(sessionResult.error);
	const session = sessionResult.data;

	const cell = {
		grant,
		userId: session.user.id,
		ownerId: session.ownerId,
		keyring: session.keyring,
	} satisfies PersistedAuth;
	const saved = await saveMachineTokens(cell, { filePath: authFilePath });
	if (saved.error) return Err(saved.error);

	return Ok({
		identity: {
			user: { id: session.user.id, email: session.user.email },
			keyring: session.keyring,
		},
	});
}

/**
 * Load the persisted cell and verify it by hitting `/api/session` through a
 * regular `createOAuthAppAuth` client (so refresh-on-401 fires automatically
 * and the same-owner guard wipes the cell on mismatch). Returns `unverified`
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
	const authFilePath = filePath ?? machineAuthFilePath({ baseURL });
	const loaded = await loadMachineTokens({
		filePath: authFilePath,
		log,
	});
	if (loaded.error) return Err(loaded.error);
	if (!loaded.data) return Ok({ status: 'signedOut' as const });
	const cachedCell = loaded.data;

	const clientResult = await createMachineAuthClient({
		baseURL,
		clientId,
		filePath: authFilePath,
		fetch,
		log,
		now,
	});
	if (clientResult.error) return Err(clientResult.error);
	const client = clientResult.data;

	let response: Response;
	try {
		response = await client.fetch(API_ROUTES.session.pattern);
	} catch {
		return Ok({
			status: 'unverified' as const,
			identity: {
				user: { id: cachedCell.userId, email: '' },
				keyring: cachedCell.keyring,
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
				keyring: session.keyring,
			},
		});
	}

	// Network or auth failure. Cell may still be valid for local decrypt; the
	// underlying auth client will have wiped it on same-owner mismatch or
	// reauth-required already. Email is unknown without /api/session.
	return Ok({
		status: 'unverified' as const,
		identity: {
			user: { id: cachedCell.userId, email: '' },
			keyring: cachedCell.keyring,
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
	const authFilePath = filePath ?? machineAuthFilePath({ baseURL });
	const loaded = await loadMachineTokens({
		filePath: authFilePath,
		log,
	});
	if (loaded.error) return Err(loaded.error);
	if (!loaded.data) return Ok({ status: 'signedOut' as const });

	const clientResult = await createMachineAuthClient({
		baseURL,
		clientId,
		filePath: authFilePath,
		fetch,
		log,
		now,
	});
	if (clientResult.error) return Err(clientResult.error);
	await clientResult.data.signOut();
	return Ok({ status: 'loggedOut' as const });
}

/**
 * Load the persisted cell and construct an `AuthClient` over it. Daemons
 * call this on boot; they never spawn an interactive sign-in launcher.
 *
 * Returns a typed `Result`. `NoSavedSession` means the user must run
 * `epicenter auth login`; `StorageFailed` / `PermissionsTooOpen` indicate
 * an on-disk fault.
 */
export async function createMachineAuthClient({
	baseURL = EPICENTER_API_URL,
	clientId = EPICENTER_CLI_OAUTH_CLIENT_ID,
	filePath,
	fetch = globalThis.fetch.bind(globalThis),
	log = createLogger('machine-auth'),
	now = Date.now,
}: CommonConfig = {}): Promise<Result<AuthClient, MachineAuthStorageError>> {
	const authFilePath = filePath ?? machineAuthFilePath({ baseURL });
	const loaded = await loadMachineTokens({
		filePath: authFilePath,
		log,
	});
	if (loaded.error) return Err(loaded.error);
	if (!loaded.data) {
		return Err(
			MachineAuthStorageError.NoSavedSession({
				filePath: authFilePath,
				baseURL,
			}).error,
		);
	}
	let currentCell: PersistedAuth | null = loaded.data;
	return Ok(
		createOAuthAppAuth({
			baseURL,
			clientId,
			launcher: {
				// Daemons never sign in interactively; a human must run
				// `epicenter auth login` to refresh the persisted cell.
				startSignIn: async () =>
					Err(
						new Error(
							'Machine auth clients cannot start interactive sign-in. Run `epicenter auth login` first.',
						),
					),
			},
			persistedAuthStorage: {
				get: () => currentCell,
				set: async (next) => {
					const saved = await saveMachineTokens(next, {
						filePath: authFilePath,
					});
					if (saved.error) throw saved.error;
					currentCell = next;
				},
			},
			fetch,
			now,
		}),
	);
}

/**
 * Resolve the local workspace identity for a freshly exchanged OOB grant.
 *
 * This is intentionally local to machine login. Long-lived clients use
 * `createOAuthAppAuth`, but login needs one explicit `/api/session` call so it
 * can both persist `PersistedAuth` and return the email for CLI output.
 */
async function fetchApiSession(
	baseURL: string,
	accessToken: string,
	fetch: AuthFetch,
): Promise<Result<ApiSessionResponse, MachineAuthRequestError>> {
	let response: Response;
	try {
		response = await fetch(API_ROUTES.session.url(baseURL), {
			headers: { Authorization: `Bearer ${accessToken}` },
			credentials: 'omit',
		});
	} catch (cause) {
		return Err(MachineAuthRequestError.RequestFailed({ cause }).error);
	}
	if (response.status !== 200) {
		return Err(
			MachineAuthRequestError.RequestFailed({
				cause: new Error(
					`${API_ROUTES.session.pattern} returned ${response.status}.`,
				),
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
