/**
 * Per-user CLI path helpers under `~/.epicenter/`.
 *
 * Override the home directory by setting `$EPICENTER_HOME`.
 */

import { epicenterHome } from '@epicenter/constants/paths';
import { join } from 'node:path';

/** Path to the auth sessions file (`<home>/auth/sessions.json`). */
export function authSessionsPath(): string {
	return join(epicenterHome(), 'auth', 'sessions.json');
}
