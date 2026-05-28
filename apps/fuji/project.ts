/**
 * Fuji project mount.
 *
 * `fuji(opts?)` returns the `Mount` that any project's `epicenter.config.ts`
 * default-exports. Default disk paths follow the library convention
 * (`.epicenter/sqlite/<id>.db`, `.epicenter/md/<id>/`); options let a project
 * override the markdown directory (typically to surface entries at the project
 * root) and the SQLite file.
 *
 * What this does:
 *   1. workspace root doc (encrypted tables + KV via createFujiWorkspace)
 *   2. SQLite materializer at `opts.sqliteFile ?? sqlitePath(...)`
 *   3. Markdown materializer at `opts.markdownDir ?? markdownPath(...)`
 *   4. infrastructure: Yjs log persistence + cloud sync via
 *      `attachProjectInfrastructure`
 */

import { isAbsolute, join } from 'node:path';
import { defineWorkspace } from '@epicenter/workspace';
import { defineMount } from '@epicenter/workspace/daemon';
import {
	attachMarkdownMaterializer,
	slugFilename,
} from '@epicenter/workspace/document/materializer/markdown';
import { attachBunSqliteMaterializer } from '@epicenter/workspace/document/materializer/sqlite';
import {
	attachProjectInfrastructure,
	markdownPath,
	sqlitePath,
} from '@epicenter/workspace/node';
import { createLogger } from 'wellcrafted/logger';
import { createFujiWorkspace } from './fuji.workspace.js';

export type FujiMountOptions = {
	/** Markdown directory; relative paths resolve against `projectDir`. */
	markdownDir?: string;
	/** SQLite file path; relative paths resolve against `projectDir`. */
	sqliteFile?: string;
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
			} = ctx;

			const workspace = createFujiWorkspace({ keyring });
			workspace.ydoc.clientID = yDocClientId;

			const sqliteFile =
				opts.sqliteFile === undefined
					? sqlitePath(projectDir, workspace.ydoc.guid)
					: resolveProjectPath(projectDir, opts.sqliteFile);
			const mdDir =
				opts.markdownDir === undefined
					? markdownPath(projectDir, workspace.ydoc.guid)
					: resolveProjectPath(projectDir, opts.markdownDir);

			attachBunSqliteMaterializer(workspace, {
				filePath: sqliteFile,
				log: createLogger(`${mount}-sqlite`),
			});
			attachMarkdownMaterializer(workspace, {
				dir: mdDir,
				perTable: { entries: { filename: slugFilename('title') } },
			});

			const infrastructure = attachProjectInfrastructure(workspace.ydoc, {
				projectDir,
				ownerId,
				deviceId,
				openWebSocket,
				onReconnectSignal,
				actions: workspace.actions,
			});

			return defineWorkspace({
				...workspace,
				...infrastructure,
			});
		},
	});
}

export type FujiMount = ReturnType<typeof fuji>;

function resolveProjectPath(projectDir: string, value: string): string {
	return isAbsolute(value) ? value : join(projectDir, value);
}
