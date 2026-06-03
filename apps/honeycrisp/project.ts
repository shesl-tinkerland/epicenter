/**
 * Honeycrisp project mount.
 *
 * `honeycrisp(opts?)` returns the `Mount` that a project's
 * `epicenter.config.ts` default-exports. Disk paths are hardcoded to the vault
 * layout: the SQLite mirror at `.epicenter/sqlite/<id>.db` (hidden) and the
 * read-only markdown projection at `apps/honeycrisp/` (visible).
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
import { createHoneycrisp } from './honeycrisp.js';

export type HoneycrispMountOptions = {
	git?: GitAutosaveConfig;
};

export function honeycrisp(opts: HoneycrispMountOptions = {}) {
	return defineMount({
		name: 'honeycrisp',
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

			const workspace = createHoneycrisp({ keyring });
			workspace.ydoc.clientID = yDocClientId;

			const sqliteFile = sqlitePath(projectDir, workspace.ydoc.guid);
			const mdDir = appsMarkdownPath(projectDir, mount);

			const sqlite = attachBunSqliteMaterializer(workspace, {
				filePath: sqliteFile,
				log: createLogger(`${mount}-sqlite`),
			});

			const markdown = attachMarkdownExport(workspace, {
				dir: mdDir,
				tables: { notes: {} },
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

export type HoneycrispMount = ReturnType<typeof honeycrisp>;
