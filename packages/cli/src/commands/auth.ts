/**
 * `epicenter auth`: manage authentication with Epicenter servers.
 *
 * Uses the RFC 8628 device code flow: the CLI prints a URL and one-time code,
 * the user approves in a browser, and the CLI picks up the session automatically.
 *
 * All sessions stored in the unified auth store at `$EPICENTER_HOME/auth/sessions.json`.
 *
 * Server URL is a positional with a default (`https://api.epicenter.so`).
 * Self-hosters pass their own URL; everyone else omits it.
 */

import { defineCommand } from 'citty';
import { createAuthApi } from '../auth/api';
import { createSessionStore } from '../auth/session-store';

const DEFAULT_SERVER = 'https://api.epicenter.so';

const sessions = createSessionStore();

/**
 * `auth` command group.
 *
 * @example
 * ```bash
 * epicenter auth login                             # defaults to api.epicenter.so
 * epicenter auth login https://self-hosted.com     # self-hosted override
 * epicenter auth status
 * epicenter auth logout
 * ```
 */
const loginCommand = defineCommand({
	meta: {
		name: 'login',
		description: 'Log in to an Epicenter server (opens browser)',
	},
	args: {
		server: {
			type: 'positional',
			description: `Server URL (default: ${DEFAULT_SERVER})`,
			required: false,
		},
	},
	run: async ({ args }) => {
		const serverUrl =
			typeof args.server === 'string' && args.server.length > 0
				? args.server
				: DEFAULT_SERVER;
		const api = createAuthApi(serverUrl);
		const codeData = await api.requestDeviceCode();

		console.log(`\nVisit: ${codeData.verification_uri_complete}`);
		console.log(`Enter code: ${codeData.user_code}\n`);

		let interval = codeData.interval * 1000;
		const deadline = Date.now() + codeData.expires_in * 1000;

		while (Date.now() < deadline) {
			await Bun.sleep(interval);
			const tokenData = await api.pollDeviceToken(codeData.device_code);

			if ('access_token' in tokenData) {
				const authed = createAuthApi(serverUrl, tokenData.access_token);
				const sessionData = await authed.getSession();

				await sessions.save(serverUrl, tokenData, sessionData);

				const displayName =
					sessionData.user?.name ?? sessionData.user?.email ?? serverUrl;
				console.log(`✓ Logged in as ${displayName}`);
				return;
			}

			switch (tokenData.error) {
				case 'authorization_pending':
					continue;
				case 'slow_down':
					interval += 5_000;
					continue;
				case 'expired_token':
					throw new Error('Device code expired. Please run login again.');
				case 'access_denied':
					throw new Error('Authorization denied: you rejected the request');
				default:
					throw new Error(tokenData.error_description ?? tokenData.error);
			}
		}
		throw new Error('Device code expired. Please run login again.');
	},
});

const logoutCommand = defineCommand({
	meta: {
		name: 'logout',
		description: 'Log out from an Epicenter server (default: most recent session)',
	},
	args: {
		server: {
			type: 'positional',
			description: 'Server URL (default: most recent session)',
			required: false,
		},
	},
	run: async ({ args }) => {
		const server = typeof args.server === 'string' ? args.server : undefined;
		const session = server
			? await sessions.load(server)
			: await sessions.loadDefault();

		if (!session) {
			console.log('No active session.');
			return;
		}

		// Best-effort remote sign-out
		try {
			const api = createAuthApi(session.server, session.accessToken);
			await api.signOut();
		} catch {
			// Remote may be unreachable
		}

		await sessions.clear(session.server);
		console.log('✓ Logged out.');
	},
});

const statusCommand = defineCommand({
	meta: {
		name: 'status',
		description: 'Show current authentication status (default: most recent session)',
	},
	args: {
		server: {
			type: 'positional',
			description: 'Server URL (default: most recent session)',
			required: false,
		},
	},
	run: async ({ args }) => {
		const server = typeof args.server === 'string' ? args.server : undefined;
		const session = server
			? await sessions.load(server)
			: await sessions.loadDefault();

		if (!session) {
			console.log('Not logged in.');
			return;
		}

		const api = createAuthApi(session.server, session.accessToken);

		try {
			const remote = await api.getSession();
			const displayName = remote.user.name ?? remote.user.email;
			console.log(`Logged in as: ${displayName} (${remote.user.email})`);
			console.log(`Server:       ${session.server}`);
			console.log(`Session:      valid`);
			if (remote.session.expiresAt) {
				console.log(
					`Expires at:   ${new Date(remote.session.expiresAt).toLocaleString()}`,
				);
			}
		} catch {
			const displayName =
				session.user?.name ?? session.user?.email ?? '(unknown)';
			console.log(`Logged in as: ${displayName} [stored]`);
			console.log(`Server:       ${session.server}`);
			console.warn('Warning: Could not verify session with remote server.');
		}
	},
});

export const authCommand = defineCommand({
	meta: {
		name: 'auth',
		description: 'Manage authentication with Epicenter servers',
	},
	subCommands: {
		login: loginCommand,
		logout: logoutCommand,
		status: statusCommand,
	},
});
