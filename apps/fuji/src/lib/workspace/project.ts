/**
 * Fuji project mount.
 *
 * `fuji(opts?)` returns the `Mount` that any project's `epicenter.config.ts`
 * default-exports. Disk paths are hardcoded to the vault layout: the SQLite
 * mirror lives at `.epicenter/sqlite/<id>.db` (hidden, machine-queried) and the
 * markdown projection at `apps/fuji/` (visible, human-read).
 *
 * What this does:
 *   1. workspace root doc (encrypted tables + KV via createFuji)
 *   2. SQLite materializer at `sqlitePath(...)`
 *   3. Markdown export (read-only, one-way) at `appsMarkdownPath(projectDir,
 *      mount)`; each entry's body is rendered from its content doc via
 *      `serializeEntryBody`, read fresh over the cloud per row and never
 *      persisted on the daemon. There is no import path: the only way to mutate
 *      an entry is through a validated action, never by editing the `.md`.
 *   4. infrastructure: Yjs log persistence + cloud sync via
 *      `attachProjectInfrastructure`
 */

import { EPICENTER_API_URL } from '@epicenter/constants/apps';
import {
	defineActions,
	defineWorkspace,
	readRoomOverHttp,
} from '@epicenter/workspace';
import { defineMount } from '@epicenter/workspace/daemon';
import {
	attachGitAutosave,
	attachMarkdownExport,
	type GitAutosaveConfig,
} from '@epicenter/workspace/document/materializer/markdown';
import { attachBunSqliteMaterializer } from '@epicenter/workspace/document/materializer/sqlite';
import {
	appsMarkdownPath,
	attachProjectInfrastructure,
	sqlitePath,
} from '@epicenter/workspace/node';
import { createLogger } from 'wellcrafted/logger';
import { serializeEntryBody } from './entry-body-markdown.js';
import { createFuji, type Entry, entryContentDocGuid } from './index.js';

export type FujiMountOptions = {
	/** Enable per-materializer Git autosave for markdown output. */
	git?: GitAutosaveConfig;
};

export function fuji(opts: FujiMountOptions = {}) {
	return defineMount({
		name: 'fuji',
		open(ctx) {
			const {
				projectDir,
				mount,
				yDocClientId,
				deviceId,
				ownerId,
				keyring,
				openWebSocket,
				onReconnectSignal,
				fetch,
			} = ctx;

			const workspace = createFuji({ keyring });
			workspace.ydoc.clientID = yDocClientId;

			const sqliteFile = sqlitePath(projectDir, workspace.ydoc.guid);
			const mdDir = appsMarkdownPath(projectDir, mount);

			const sqlite = attachBunSqliteMaterializer(workspace, {
				filePath: sqliteFile,
				log: createLogger(`${mount}-sqlite`),
			});
			/**
			 * Render one entry's body from its content doc for the read-only
			 * projection. The body lives in a separate cloud doc addressed by
			 * `entryContentDocGuid(id)`; the daemon does not mirror it, so we GET its
			 * current snapshot over one-shot HTTP and serialize that (see
			 * `readRoomOverHttp` for why HTTP, not a socket). No local persistence: a
			 * body read is a read, not a second on-disk copy.
			 *
			 * Throws on a failed or timed-out GET so the materializer skips the write
			 * and leaves the existing `.md` intact rather than clobbering it with an
			 * empty body.
			 */
			const readEntryBody = (entry: Entry): Promise<string> =>
				readRoomOverHttp({
					fetch,
					baseURL: EPICENTER_API_URL,
					ownerId,
					guid: entryContentDocGuid(entry.id),
					read: (ydoc) => serializeEntryBody(ydoc.getXmlFragment('content')),
				});

			const markdown = attachMarkdownExport(workspace, {
				dir: mdDir,
				log: createLogger(`${mount}-markdown`),
				tables: {
					entries: {
						// One-way render: frontmatter is the row, body is the entry's prose
						// read fresh from its content doc. Read every time the row changes;
						// a daemon restart re-reads all bodies, self-healing any `.md` left
						// stale by a cross-doc sync race (root `updatedAt` arriving before
						// the body update).
						toMarkdown: async (entry) => ({
							frontmatter: { ...entry },
							body: await readEntryBody(entry),
						}),
					},
				},
			});
			if (opts.git) {
				attachGitAutosave({
					ydoc: workspace.ydoc,
					dir: mdDir,
					config: opts.git,
				});
			}

			const actions = defineActions({
				...workspace.actions,
				...sqlite.actions,
				...markdown.actions,
			});

			const infrastructure = attachProjectInfrastructure(workspace.ydoc, {
				baseURL: EPICENTER_API_URL,
				projectDir,
				ownerId,
				deviceId,
				openWebSocket,
				onReconnectSignal,
				actions,
				materializers: [sqlite, markdown],
			});

			return defineWorkspace({
				...workspace,
				...infrastructure,
				markdown,
				actions,
			});
		},
	});
}

export type FujiMount = ReturnType<typeof fuji>;
