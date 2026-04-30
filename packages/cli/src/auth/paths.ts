/**
 * Per-user CLI path helpers under `~/.epicenter/`.
 *
 * Override the home directory by setting `$EPICENTER_HOME`.
 */

import { EPICENTER_USER_DIR_NAME } from '@epicenter/constants/paths';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** `$EPICENTER_HOME` env, then `~/.epicenter/`. */
export function epicenterHome(): string {
	return Bun.env.EPICENTER_HOME ?? join(homedir(), EPICENTER_USER_DIR_NAME);
}

/** Path to the auth sessions file (`<home>/auth/sessions.json`). */
export function authSessionsPath(): string {
	return join(epicenterHome(), 'auth', 'sessions.json');
}
