/**
 * Filesystem path helpers shared by the daemon and any consumer that needs
 * to address Epicenter's per-user or per-workspace state directories.
 *
 * Two conventions:
 *
 *   per-user:       `~/.epicenter/`            (auth sessions, daemon sockets)
 *   per-workspace:  `<absDir>/.epicenter/`     (SQLite persistence, materializers)
 *
 * Override the per-user root with `$EPICENTER_HOME`.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Resolve the Epicenter home directory.
 *
 * Resolution: `$EPICENTER_HOME` env, then `~/.epicenter/`. The same root
 * holds auth sessions (cli) and daemon sockets/logs (workspace) so all
 * per-user state lives in one tree regardless of which package wrote it.
 */
export function epicenterHome(): string {
	return Bun.env.EPICENTER_HOME ?? join(homedir(), '.epicenter');
}

/**
 * Path to a workspace's SQLite persistence file.
 *
 * Convention: `<absDir>/.epicenter/persistence/<workspaceId>.db`.
 * `absDir` is the project root (where `epicenter.config.ts` lives);
 * `workspaceId` is `ws.ydoc.guid`.
 *
 * @example
 * ```ts
 * persistencePath('/Users/braden/Code/vault', 'epicenter.fuji')
 * // → '/Users/braden/Code/vault/.epicenter/persistence/epicenter.fuji.db'
 * ```
 */
export function persistencePath(absDir: string, workspaceId: string): string {
	return join(absDir, '.epicenter', 'persistence', `${workspaceId}.db`);
}
