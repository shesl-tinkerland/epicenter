import { EPICENTER_API_URL } from '@epicenter/constants/apps';
import { EPICENTER_CLI_OAUTH_CLIENT_ID } from '@epicenter/constants/oauth';
import { EncryptionKeys } from '@epicenter/encryption';
import type { BetterAuthOptions } from 'better-auth';
import { createAuthClient, InferPlugin } from 'better-auth/client';
import { deviceAuthorizationClient } from 'better-auth/client/plugins';
import type { customSession } from 'better-auth/plugins';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { createLogger, type Logger } from 'wellcrafted/logger';
import { Err, Ok, type Result } from 'wellcrafted/result';
import { type BearerSession } from '../auth-types.js';
import {
	type BetterAuthSessionResponse,
	normalizeAuthUser,
} from '../contracts/auth-session.js';
import { type AuthClient, createBearerAuth } from '../create-auth.js';
import {
	loadMachineSession,
	saveMachineSession,
} from './machine-session-store.js';

type EpicenterCustomSessionPlugin = ReturnType<
	typeof customSession<BetterAuthSessionResponse, BetterAuthOptions>
>;

const rawDefaultAuthClient = createAuthClient({
	baseURL: EPICENTER_API_URL,
	basePath: '/auth',
	plugins: [
		InferPlugin<EpicenterCustomSessionPlugin>(),
		deviceAuthorizationClient(),
	],
});

const defaultAuthClient =
	rawDefaultAuthClient as typeof rawDefaultAuthClient & {
		deviceCode: typeof rawDefaultAuthClient.device.code;
		deviceToken: typeof rawDefaultAuthClient.device.token;
	};

type MachineAuthClient = typeof defaultAuthClient;

export const MachineAuthRequestError = defineErrors({
	RequestFailed: ({ cause }: { cause: unknown }) => ({
		message: `Auth transport request failed: ${extractErrorMessage(cause)}`,
		cause,
	}),
});
export type MachineAuthRequestError = InferErrors<
	typeof MachineAuthRequestError
>;

export const DeviceTokenError = defineErrors({
	DeviceCodeExpired: () => ({
		message: 'Device code expired. Run login again.',
	}),
	DeviceAccessDenied: () => ({
		message: 'Authorization denied.',
	}),
	DeviceAuthorizationFailed: ({
		code,
		description,
	}: {
		code: string;
		description?: string;
	}) => ({
		message: description ?? code,
		code,
		description,
	}),
});
export type DeviceTokenError = InferErrors<typeof DeviceTokenError>;

type MachineSessionSummary = {
	user: Pick<BearerSession['user'], 'id' | 'name' | 'email'>;
};

function sessionSummary(session: BearerSession): MachineSessionSummary {
	return {
		user: {
			id: session.user.id,
			name: session.user.name,
			email: session.user.email,
		},
	};
}

/**
 * Start Better Auth device-code login and save the resulting session.
 */
export async function loginWithDeviceCode({
	authClient = defaultAuthClient,
	sleep = Bun.sleep,
	backend = Bun.secrets,
	onDeviceCode,
}: {
	authClient?: MachineAuthClient;
	sleep?: (ms: number) => Promise<void>;
	backend?: typeof Bun.secrets;
	onDeviceCode?: (device: {
		userCode: string;
		verificationUriComplete: string;
	}) => void | Promise<void>;
} = {}) {
	const { data: code, error: codeError } = await authClient.deviceCode({
		client_id: EPICENTER_CLI_OAUTH_CLIENT_ID,
	});
	if (codeError) {
		return MachineAuthRequestError.RequestFailed({ cause: codeError });
	}

	const device = {
		userCode: code.user_code,
		verificationUriComplete: code.verification_uri_complete,
	};
	await onDeviceCode?.(device);

	const { data: accessToken, error: pollError } = await pollForAccessToken({
		authClient,
		deviceCode: code.device_code,
		intervalMs: code.interval * 1000,
		expiresInMs: code.expires_in * 1000,
		sleep,
	});
	if (pollError) return Err(pollError);

	const { data: session, error: fetchError } = await fetchBearerSession({
		authClient,
		accessToken,
	});
	if (fetchError) return Err(fetchError);

	const { error: saveError } = await saveMachineSession(session, {
		backend,
	});
	if (saveError) return Err(saveError);

	return Ok({
		status: 'loggedIn' as const,
		session: sessionSummary(session),
		device,
	});
}

/**
 * Read the saved session and verify it remotely when possible. Network
 * failures surface as `unverified`, not `Err`, so the CLI can show the cached
 * identity even when offline.
 */
export async function status({
	authClient = defaultAuthClient,
	backend = Bun.secrets,
	log = createLogger('machine-auth'),
}: {
	authClient?: MachineAuthClient;
	backend?: typeof Bun.secrets;
	log?: Logger;
} = {}) {
	const { data: session, error: loadError } = await loadMachineSession({
		backend,
		log,
	});
	if (loadError) return Err(loadError);
	if (session === null) return Ok({ status: 'signedOut' as const });

	const { data: remoteSession, error: fetchError } = await fetchBearerSession({
		authClient,
		accessToken: session.token,
	});
	if (fetchError) {
		return Ok({
			status: 'unverified' as const,
			session: sessionSummary(session),
			verificationError: fetchError,
		});
	}

	const { error: saveError } = await saveMachineSession(remoteSession, {
		backend,
	});
	if (saveError) return Err(saveError);
	return Ok({
		status: 'valid' as const,
		session: sessionSummary(remoteSession),
	});
}

export async function logout({
	authClient = defaultAuthClient,
	backend = Bun.secrets,
	log = createLogger('machine-auth'),
}: {
	authClient?: MachineAuthClient;
	backend?: typeof Bun.secrets;
	log?: Logger;
} = {}) {
	const { data: session, error: loadError } = await loadMachineSession({
		backend,
		log,
	});
	if (loadError) return Err(loadError);
	if (session === null) return Ok({ status: 'signedOut' as const });

	try {
		const { error: signOutError } = await authClient.signOut({
			fetchOptions: {
				headers: { Authorization: `Bearer ${session.token}` },
			},
		});
		if (signOutError) {
			const wrappedError = MachineAuthRequestError.RequestFailed({
				cause: signOutError,
			}).error;
			if (wrappedError) log.warn(wrappedError);
		}
	} catch (cause) {
		const wrappedError = MachineAuthRequestError.RequestFailed({
			cause,
		}).error;
		if (wrappedError) log.warn(wrappedError);
	}

	const { error: saveError } = await saveMachineSession(null, { backend });
	if (saveError) return Err(saveError);
	return Ok({ status: 'loggedOut' as const });
}

async function pollForAccessToken({
	authClient,
	deviceCode,
	intervalMs,
	expiresInMs,
	sleep,
}: {
	authClient: MachineAuthClient;
	deviceCode: string;
	intervalMs: number;
	expiresInMs: number;
	sleep: (ms: number) => Promise<void>;
}): Promise<Result<string, DeviceTokenError | MachineAuthRequestError>> {
	const deadline = Date.now() + expiresInMs;
	let interval = intervalMs;
	while (Date.now() < deadline) {
		await sleep(interval);
		const { data, error } = await authClient.deviceToken({
			grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
			device_code: deviceCode,
			client_id: EPICENTER_CLI_OAUTH_CLIENT_ID,
		});
		if (data) return Ok(data.access_token);
		if (!error) {
			return MachineAuthRequestError.RequestFailed({
				cause: new Error('device.token returned neither data nor error'),
			});
		}

		switch (error.error) {
			case 'authorization_pending':
				continue;
			case 'slow_down':
				interval += 5_000;
				continue;
			case 'expired_token':
				return DeviceTokenError.DeviceCodeExpired();
			case 'access_denied':
				return DeviceTokenError.DeviceAccessDenied();
			default:
				return DeviceTokenError.DeviceAuthorizationFailed({
					code: error.error,
					description: error.error_description,
				});
		}
	}
	return DeviceTokenError.DeviceCodeExpired();
}

async function fetchBearerSession({
	authClient,
	accessToken,
}: {
	authClient: MachineAuthClient;
	accessToken: string;
}): Promise<Result<BearerSession, MachineAuthRequestError>> {
	let rotatedToken: string | null = null;
	const { data, error } = await authClient.getSession({
		fetchOptions: {
			headers: { Authorization: `Bearer ${accessToken}` },
			onSuccess: (ctx) => {
				rotatedToken = ctx.response.headers.get('set-auth-token');
			},
		},
	});
	if (error) return MachineAuthRequestError.RequestFailed({ cause: error });
	if (data === null) {
		return MachineAuthRequestError.RequestFailed({
			cause: new Error('getSession returned null after device-code login'),
		});
	}

	try {
		return Ok({
			token: rotatedToken ?? accessToken,
			user: normalizeAuthUser(data.user),
			encryptionKeys: EncryptionKeys.assert(data.encryptionKeys),
		});
	} catch (cause) {
		return MachineAuthRequestError.RequestFailed({ cause });
	}
}

/**
 * Create an auth client backed by saved machine auth.
 *
 * Storage failures are propagated; daemons should crash rather than silently
 * boot signed-out when the keychain is unreadable.
 */
export async function createMachineAuthClient(): Promise<AuthClient> {
	const log = createLogger('machine-auth');
	const { data: initialSession, error } = await loadMachineSession();
	if (error) throw error;
	if (initialSession === null) {
		throw new Error(
			'[machine-auth] no saved session in the system keychain. ' +
				'Run `epicenter auth login` first.',
		);
	}
	return createBearerAuth({
		baseURL: EPICENTER_API_URL,
		initialSession,
		saveSession: async (next) => {
			const { error: saveError } = await saveMachineSession(next);
			if (saveError) {
				log.error(saveError);
			}
		},
	});
}
