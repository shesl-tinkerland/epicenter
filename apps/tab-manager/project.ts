/**
 * Tab Manager project mount.
 *
 * `tabManager(opts?)` returns the Mount used by `epicenter.config.ts`.
 * It projects saved tabs, bookmarks, and devices into markdown while keeping
 * the Y.Doc update log and SQLite mirror under `.epicenter/`.
 */

import { join } from 'node:path';
import { defineActions, defineWorkspace } from '@epicenter/workspace';
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
import { createTabManager } from './src/lib/workspace/definition.js';

export type TabManagerMountOptions = {
	/** Enable per-materializer Git autosave for markdown output. */
	git?: GitAutosaveConfig;
	/**
	 * Base URL of the Epicenter cloud API used for sync.
	 * Defaults to `process.env.EPICENTER_API_URL`, falling back to the hosted API.
	 */
	baseURL?: string;
};

export function tabManager(opts: TabManagerMountOptions = {}) {
	return defineSessionMount({
		name: 'tab-manager',
		open(ctx) {
			const { epicenterRoot, mount } = ctx;
			const baseURL =
				opts.baseURL ||
				process.env.EPICENTER_API_URL ||
				'https://api.epicenter.so';

			const workspace = createTabManager({ keyring: ctx.session.keyring });

			const sqlite = attachBunSqliteMaterializer(workspace, {
				filePath: sqlitePath(epicenterRoot, workspace.ydoc.guid),
				fts: {
					bookmarks: ['title', 'url'],
					savedTabs: ['title', 'url'],
				},
				log: createLogger(`${mount}-sqlite`),
			});
			const markdown = attachMarkdownExport(workspace, {
				dir: epicenterRoot,
				tables: {
					bookmarks: {},
					devices: {},
					savedTabs: {},
				},
			});
			if (opts.git) {
				for (const tableDir of ['bookmarks', 'devices', 'savedTabs']) {
					attachGitAutosave({
						ydoc: workspace.ydoc,
						dir: join(epicenterRoot, tableDir),
						config: opts.git,
					});
				}
			}

			const actions = defineActions({
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

export type TabManagerMount = ReturnType<typeof tabManager>;
