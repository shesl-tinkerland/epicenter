/**
 * Per-workspace data layout helpers.
 *
 * Hidden machine state under `<projectDir>/.epicenter/`, each folder named by
 * what's inside:
 *
 *   yjs/<id>.db     Yjs CRDT update log (durability; replayed by Yjs)
 *   sqlite/<id>.db  Queryable SQL surface (open with `sqlite3`, FTS5)
 *   md/<id>/        Legacy hidden markdown tree (playground daemons only)
 *
 * Plus the one VISIBLE projection a human reads directly:
 *
 *   apps/<mount>/   Read-only markdown projection (`appsMarkdownPath`)
 *
 * These helpers return the hardcoded convention only; they do not inspect
 * `epicenter.config.ts`.
 *
 * For daemon-process paths (sockets, log, metadata sidecar), see
 * `daemon/paths.ts`. Different audience, different rationale.
 *
 * Pure helpers: no side effects, no directory creation. Consumers do their
 * own `mkdir` (or rely on the attachments to do it).
 */

import { join } from 'node:path';

function epicenterProjectDir(projectDir: string): string {
	return join(projectDir, '.epicenter');
}

/**
 * Path to a workspace's Yjs CRDT update log.
 *
 * Convention: `<projectDir>/.epicenter/yjs/<workspaceId>.db`. This file is the
 * source of truth: every `updateV2` event lands here as a row, and the
 * file is replayed at startup to reconstruct the Y.Doc. SQLite is the
 * implementation detail; you never query this file with `sqlite3`. For
 * the queryable surface, see `sqlitePath`.
 *
 * `projectDir` is the project root (where `epicenter.config.ts` lives);
 * `workspaceId` is `ws.ydoc.guid`.
 *
 * @example
 * ```ts
 * yjsPath('/Users/braden/Code/vault', 'epicenter-fuji')
 * // '/Users/braden/Code/vault/.epicenter/yjs/epicenter-fuji.db'
 * ```
 */
export function yjsPath(projectDir: string, workspaceId: string): string {
	return join(epicenterProjectDir(projectDir), 'yjs', `${workspaceId}.db`);
}

/**
 * Convention path for a workspace's SQLite mirror file (the queryable SQL surface).
 *
 * Convention: `<projectDir>/.epicenter/sqlite/<workspaceId>.db`. The vault mount
 * factories always use this guid-keyed default; a non-vault caller can still pass
 * a custom `filePath` to `attachBunSqliteMaterializer`, in which case scripts must
 * open that explicit path with `openSqliteReader({ filePath })`.
 *
 * Distinct from `yjsPath`: the yjs file is the role (durability of the
 * Y.Doc update log; SQLite is implementation detail and you never open it
 * with `sqlite3`). This file is the surface (you open it with `sqlite3`
 * to run SELECT and FTS5 queries; that's its whole point). Different
 * shape, different concurrency profile, different consumers.
 *
 * @example
 * ```ts
 * sqlitePath('/Users/braden/Code/vault', 'epicenter-fuji')
 * // '/Users/braden/Code/vault/.epicenter/sqlite/epicenter-fuji.db'
 * ```
 */
export function sqlitePath(projectDir: string, workspaceId: string): string {
	return join(epicenterProjectDir(projectDir), 'sqlite', `${workspaceId}.db`);
}

/**
 * Root directory for a workspace's markdown materializer tree.
 *
 * Convention: `<projectDir>/.epicenter/md/<workspaceId>/` (hidden). Retained for
 * the playground daemons that still import it; the vault mount factories now
 * project to the visible `appsMarkdownPath` instead.
 *
 * @example
 * ```ts
 * markdownPath('/Users/braden/Code/vault', 'epicenter-fuji')
 * // '/Users/braden/Code/vault/.epicenter/md/epicenter-fuji'
 * ```
 */
export function markdownPath(projectDir: string, workspaceId: string): string {
	return join(epicenterProjectDir(projectDir), 'md', workspaceId);
}

/**
 * Visible directory for a mount's read-only markdown projection.
 *
 * Convention: `<projectDir>/apps/<mountName>/`. Unlike `yjs/`, `sqlite/`, and the
 * legacy `md/` tree, this lives OUTSIDE `.epicenter/` because a human reads these
 * `.md` files directly (triage, curate, grep, diff); the dot-prefixed state under
 * `.epicenter/` is for machines. Keyed by the mount NAME (so the folder reads
 * `apps/fuji`, not `apps/epicenter-fuji`), not by `ydoc.guid` like the yjs/sqlite
 * paths. This is a hardcoded constant, not a config knob: `apps/` is part of what
 * an Epicenter vault is, and `markdown_rebuild` deletes every `.md` under its
 * target, so a freeform override could wipe hand-authored markdown.
 *
 * @example
 * ```ts
 * appsMarkdownPath('/Users/braden/Code/vault', 'fuji')
 * // '/Users/braden/Code/vault/apps/fuji'
 * ```
 */
export function appsMarkdownPath(
	projectDir: string,
	mountName: string,
): string {
	return join(projectDir, 'apps', mountName);
}
