/**
 * `epicenter auth`: manage authentication with Epicenter.
 *
 * Uses an OOB (out-of-band) OAuth 2.1 authorization-code flow with PKCE.
 * `auth login` prints a URL; the user signs in on the hosted portal,
 * copies the one-time code from the success page, and pastes it into the
 * terminal. Tokens and the local workspace identity live at
 * `~/.epicenter/auth.json` with file mode 0o600.
 *
 * Same shape and same source as the browser, dashboard, and extension
 * clients (see specs/20260514T200000-api-me-three-field-token-bundle.md).
 */

import * as machineAuth from '@epicenter/auth/node';
import { cmd } from '../util/cmd.js';

function failAuthCommand(error: { message: string }) {
	console.error(error.message);
	process.exitCode = 1;
}

/**
 * `auth` command group.
 *
 * @example
 * ```bash
 * epicenter auth login
 * epicenter auth status
 * epicenter auth logout
 * ```
 */
const loginCommand = cmd({
	command: 'login',
	describe: 'Log in to Epicenter',
	handler: async () => {
		const result = await machineAuth.loginWithOob({
			print: (line) => console.log(line),
		});
		if (result.error) {
			failAuthCommand(result.error);
			return;
		}

		const email = result.data.identity.user.email;
		console.log(email ? `Signed in as ${email}.` : 'Signed in.');
	},
});

const logoutCommand = cmd({
	command: 'logout',
	describe: 'Log out from Epicenter',
	handler: async () => {
		const result = await machineAuth.logout();
		if (result.error) {
			failAuthCommand(result.error);
			return;
		}

		if (result.data.status === 'signedOut') {
			console.log('No active session.');
			return;
		}

		console.log('Logged out.');
	},
});

const statusCommand = cmd({
	command: 'status',
	describe: 'Show current authentication status',
	handler: async () => {
		const result = await machineAuth.status();
		if (result.error) {
			failAuthCommand(result.error);
			return;
		}

		if (result.data.status === 'signedOut') {
			console.log('Not logged in.');
			return;
		}

		const { identity } = result.data;
		const label = identity.user.email || 'Account';
		console.log(`Logged in as: ${label}`);
		if (result.data.status === 'valid') {
			console.log('Session:      verified');
		} else {
			console.log('Session:      stored, could not verify');
			console.warn('Warning: Could not verify session with the Epicenter API.');
		}
	},
});

export const authCommand = cmd({
	command: 'auth <subcommand>',
	describe: 'Manage authentication with Epicenter',
	builder: (yargs) =>
		yargs
			.command(loginCommand)
			.command(logoutCommand)
			.command(statusCommand)
			.demandCommand(1, 'Specify a subcommand: login, logout, or status'),
	handler: () => {},
});
