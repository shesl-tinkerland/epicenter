/**
 * Tab Manager project mount.
 *
 * `tabManager(opts?)` returns the Mount used by `epicenter.config.ts`.
 * It projects saved tabs, bookmarks, and devices into markdown while keeping
 * the Y.Doc update log and SQLite mirror under `.epicenter/`.
 */

import { EPICENTER_API_URL } from '@epicenter/constants/apps';
import { defineActions, defineWorkspace } from '@epicenter/workspace';
import { defineSessionMount } from '@epicenter/workspace/daemon';
import { attachMarkdownExport } from '@epicenter/workspace/document/materializer/markdown';
import { attachBunSqliteMaterializer } from '@epicenter/workspace/document/materializer/sqlite';
import {
	attachGitAutosave,
	attachMountInfrastructure,
	type GitAutosaveConfig,
	mountMarkdownPath,
	nodeMarkdownDeps,
	sqlitePath,
} from '@epicenter/workspace/node';
import { createLogger } from 'wellcrafted/logger';
import { createTabManager } from './src/lib/workspace/definition.js';

export type TabManagerMountOptions = {
	/** Enable per-materializer Git autosave for markdown output. */
	git?: GitAutosaveConfig;
};

export function tabManager(opts: TabManagerMountOptions = {}) {
	return defineSessionMount({
		name: 'tab-manager',
		open(ctx) {
			const { epicenterRoot, mount } = ctx;

			const workspace = createTabManager({ keyring: ctx.session.keyring });

			const mdDir = mountMarkdownPath(epicenterRoot, mount);

			const sqlite = attachBunSqliteMaterializer(workspace, {
				filePath: sqlitePath(epicenterRoot, workspace.ydoc.guid),
				fts: {
					bookmarks: ['title', 'url'],
					savedTabs: ['title', 'url'],
				},
				log: createLogger(`${mount}-sqlite`),
			});
			const markdown = attachMarkdownExport(workspace, {
				dir: mdDir,
				...nodeMarkdownDeps,
				tables: {
					bookmarks: {},
					devices: {},
					savedTabs: {},
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
				...sqlite.actions,
				...markdown.actions,
			});

			const infrastructure = attachMountInfrastructure(workspace.ydoc, ctx, {
				baseURL: EPICENTER_API_URL,
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
