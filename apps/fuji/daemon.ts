/**
 * Fuji daemon extension entrypoint.
 *
 * Composes daemon-only attachments (Yjs log, collaboration, SQLite materializer,
 * Markdown materializer) around the shared
 * `openFujiWorkspace(attachEncryption)` opener. The browser composes
 * browser-only attachments around the same opener.
 *
 * Folder-routed daemon extension contract: the default export is a
 * `DaemonWorkspaceModule` whose `open(ctx)` receives capabilities (the
 * encryption attacher, the auth-bound WebSocket factory) and identity
 * (`projectDir`, `route`, `clientId`, `replicaId`) from the host. The host
 * refuses to open extensions when auth is signed-out, so the keyring closure
 * baked into `ctx.attachEncryption` is the only auth touchpoint on this side.
 *
 * Actions and the Y.Doc clientID are owned by the shared workspace opener;
 * this file only composes daemon-side disk/network attachments.
 */

import { EPICENTER_API_URL } from '@epicenter/constants/apps';
import { openCollaboration, roomWsUrl } from '@epicenter/workspace';
import { defineDaemonWorkspace } from '@epicenter/workspace/daemon';
import {
	attachMarkdownMaterializer,
	slugFilename,
} from '@epicenter/workspace/document/materializer/markdown';
import { attachSqliteMaterializer } from '@epicenter/workspace/document/materializer/sqlite';
import {
	attachYjsLog,
	markdownPath,
	openWriterSqlite,
	sqlitePath,
	yjsPath,
} from '@epicenter/workspace/node';
import { createLogger } from 'wellcrafted/logger';
import { openFujiWorkspace } from './workspace.js';

export default defineDaemonWorkspace({
	async open({
		projectDir,
		route,
		clientId,
		replicaId,
		attachEncryption,
		openWebSocket,
	}) {
		const workspace = openFujiWorkspace(attachEncryption, { clientId });

		const yjsLog = attachYjsLog(workspace.ydoc, {
			filePath: yjsPath(projectDir, workspace.ydoc.guid),
		});

		const collaboration = openCollaboration(workspace.ydoc, {
			url: roomWsUrl(EPICENTER_API_URL, workspace.ydoc.guid),
			openWebSocket,
			replicaId,
			actions: workspace.actions,
		});

		const sqliteDb = openWriterSqlite({
			filePath: sqlitePath(projectDir, workspace.ydoc.guid),
			log: createLogger(`${route}-sqlite`),
		});
		workspace.ydoc.once('destroy', () => sqliteDb.close());

		attachSqliteMaterializer(workspace.ydoc, { db: sqliteDb }).table(
			workspace.tables.entries,
		);
		attachMarkdownMaterializer(workspace.ydoc, {
			dir: markdownPath(projectDir, workspace.ydoc.guid),
		}).table(workspace.tables.entries, { filename: slugFilename('title') });

		return {
			collaboration,
			yjsLog,
			async [Symbol.asyncDispose]() {
				workspace.ydoc.destroy();
				await Promise.all([
					collaboration.whenDisposed,
					yjsLog.whenDisposed,
				]);
			},
		};
	},
});
