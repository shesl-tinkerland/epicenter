import { join } from 'node:path';

/**
 * Path to the per-workspace SQLite persistence file.
 *
 * Local convention: `<absDir>/.epicenter/persistence/<workspaceId>.db`.
 *
 * `absDir` is the project root (usually where `epicenter.config.ts` lives).
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
