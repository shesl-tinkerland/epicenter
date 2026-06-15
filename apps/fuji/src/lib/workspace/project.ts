/**
 * Fuji project mount.
 *
 * `fuji(opts?)` returns the `Mount` that an `epicenter.config.ts`
 * default-exports. Disk paths follow the Epicenter-root layout: the
 * SQLite mirror lives at `.epicenter/sqlite/<id>.db` (hidden, machine-queried)
 * and the markdown projection at table-named folders under the app root
 * (`<epicenterRoot>/entries/` for Fuji).
 *
 * What this does:
 *   1. workspace root doc (encrypted tables + KV via createFuji)
 *   2. SQLite materializer at `sqlitePath(...)`
 *   3. Markdown export (read-only, one-way) under the app root; each entry's
 *      body is rendered from its content doc via `serializeEntryBody`, read
 *      fresh over the cloud per row and never persisted on the daemon. There is
 *      no import path: the only way to mutate an entry is through a validated
 *      action, never by editing the `.md`.
 *   4. infrastructure: Yjs log persistence + cloud sync via
 *      `attachMountInfrastructure`
 */

import { join } from 'node:path';
import {
	defineActions,
	defineWorkspace,
	readRoomOverHttp,
} from '@epicenter/workspace';
import { defineSessionMount } from '@epicenter/workspace/daemon';
import {
	attachGitAutosave,
	attachMarkdownExport,
	type GitAutosaveConfig,
} from '@epicenter/workspace/document/materializer/markdown';
import { attachBunSqliteMaterializer } from '@epicenter/workspace/document/materializer/sqlite';
import {
	attachMountInfrastructure,
	sqlitePath,
} from '@epicenter/workspace/node';
import { createLogger } from 'wellcrafted/logger';
import { serializeEntryBody } from './entry-body-markdown.js';
import { createFuji, type Entry, entryContentDocGuid } from './index.js';

export type FujiMountOptions = {
	/** Enable per-materializer Git autosave for markdown output. */
	git?: GitAutosaveConfig;
	/**
	 * Base URL of the Epicenter cloud API used for entry-body reads and sync.
	 * Defaults to `process.env.EPICENTER_API_URL`, falling back to the hosted API.
	 */
	baseURL?: string;
};

export function fuji(opts: FujiMountOptions = {}) {
	return defineSessionMount({
		name: 'fuji',
		open(ctx) {
			const { epicenterRoot, mount, session } = ctx;
			const baseURL =
				opts.baseURL ||
				process.env.EPICENTER_API_URL ||
				'https://api.epicenter.so';

			const workspace = createFuji({ keyring: session.keyring });

			const sqlite = attachBunSqliteMaterializer(workspace, {
				filePath: sqlitePath(epicenterRoot, workspace.ydoc.guid),
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
					fetch: session.fetch,
					baseURL,
					ownerId: session.ownerId,
					guid: entryContentDocGuid(entry.id),
					read: (ydoc) => serializeEntryBody(ydoc.getXmlFragment('content')),
				});

			const markdown = attachMarkdownExport(workspace, {
				dir: epicenterRoot,
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
					dir: join(epicenterRoot, 'entries'),
					config: opts.git,
				});
			}

			const actions = defineActions({
				...workspace.actions,
				...sqlite.actions,
				...markdown.actions,
			});

			const infrastructure = attachMountInfrastructure(workspace.ydoc, ctx, {
				baseURL,
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
