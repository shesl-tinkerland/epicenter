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

import type { Argv, CommandModule } from 'yargs';
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
export const authCommand: CommandModule = {
	command: 'auth <subcommand>',
	describe: 'Manage authentication with Epicenter servers',
	builder: (yargs: Argv) =>
		yargs
			.command({
				command: 'login [server]',
				describe: 'Log in to an Epicenter server (opens browser)',
				builder: (y: Argv) =>
					y
						.positional('server', {
							type: 'string',
							default: DEFAULT_SERVER,
							describe: 'Server URL (override for self-hosted)',
						})
						.example('$0 auth login', 'Log in to the public Epicenter server')
						.example(
							'$0 auth login https://self-hosted.example.com',
							'Log in to a self-hosted instance',
						),
				handler: async (argv) => {
					const serverUrl = argv.server as string;
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
								sessionData.user?.name ??
								sessionData.user?.email ??
								serverUrl;
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
								throw new Error(
									'Device code expired. Please run login again.',
								);
							case 'access_denied':
								throw new Error(
									'Authorization denied: you rejected the request',
								);
							default:
								throw new Error(
									tokenData.error_description ?? tokenData.error,
								);
						}
					}
					throw new Error('Device code expired. Please run login again.');
				},
			} satisfies CommandModule)
			.command({
				command: 'logout [server]',
				describe:
					'Log out from an Epicenter server (default: most recent session)',
				builder: (y: Argv) =>
					y.positional('server', {
						type: 'string',
						describe: 'Server URL (default: most recent session)',
					}),
				handler: async (argv) => {
					const server =
						typeof argv.server === 'string' ? argv.server : undefined;
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
			} satisfies CommandModule)
			.command({
				command: 'status [server]',
				describe:
					'Show current authentication status (default: most recent session)',
				builder: (y: Argv) =>
					y.positional('server', {
						type: 'string',
						describe: 'Server URL (default: most recent session)',
					}),
				handler: async (argv) => {
					const server =
						typeof argv.server === 'string' ? argv.server : undefined;
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
						console.log(
							`Logged in as: ${displayName} (${remote.user.email})`,
						);
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
						console.warn(
							'Warning: Could not verify session with remote server.',
						);
					}
				},
			} satisfies CommandModule)
			.demandCommand(1, 'Specify a subcommand: login, logout, or status'),
	handler: () => {},
};
