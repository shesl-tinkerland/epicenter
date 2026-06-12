/**
 * Tab Manager project mount.
 *
 * `tabManager(opts?)` returns the Mount used by `epicenter.config.ts`.
 * It projects saved tabs, bookmarks, and devices into markdown while keeping
 * the Y.Doc update log and SQLite mirror under `.epicenter/`.
 */

import { EPICENTER_API_URL } from '@epicenter/constants/apps';
import { defineActions, defineWorkspace } from '@epicenter/workspace';
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
import { createTabManager } from './src/lib/workspace/definition.js';

export type TabManagerMountOptions = {
	/** Enable per-materializer Git autosave for markdown output. */
	git?: GitAutosaveConfig;
};

export function tabManager(opts: TabManagerMountOptions = {}) {
	return defineMount({
		name: 'tab-manager',
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
			} = ctx;

			const workspace = createTabManager({ keyring });
			workspace.ydoc.clientID = yDocClientId;

			const sqliteFile = sqlitePath(projectDir, workspace.ydoc.guid);
			const mdDir = appsMarkdownPath(projectDir, mount);

			const sqlite = attachBunSqliteMaterializer(workspace, {
				filePath: sqliteFile,
				fts: {
					bookmarks: ['title', 'url'],
					savedTabs: ['title', 'url'],
				},
				log: createLogger(`${mount}-sqlite`),
			});
			const markdown = attachMarkdownExport(workspace, {
				dir: mdDir,
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

export type TabManagerMount = ReturnType<typeof tabManager>;
