/**
 * Fuji daemon extension entrypoint.
 *
 * Composes daemon-only attachments (Yjs log, collaboration, SQLite materializer,
 * Markdown materializer) around the shared
 * `openFujiWorkspace(attachEncryption)` opener. The browser composes
 * browser-only attachments around the same opener.
 *
 * Folder-routed daemon extension contract: the default export is a
 * `DaemonWorkspaceModule` whose `open(ctx)` receives the shared auth client,
 * the resolved project directory, the folder-derived route, plus the
 * host-derived `clientId` and `replicaId`. The host refuses to call `open`
 * when auth is signed-out, so this body only guards inside the lazy keyring
 * closure for late sign-outs.
 *
 * Actions and the Y.Doc clientID are owned by the shared workspace opener;
 * this file only composes daemon-side disk/network attachments.
 */

import { EPICENTER_API_URL } from '@epicenter/constants/apps';
import {
	attachEncryption,
	openCollaboration,
	roomWsUrl,
} from '@epicenter/workspace';
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
	async open({ auth, projectDir, route, clientId, replicaId }) {
		const workspace = openFujiWorkspace(
			(ydoc) =>
				attachEncryption(ydoc, {
					keyring: () => {
						if (auth.state.status === 'signed-out') {
							throw new Error(`[${route}-daemon] auth signed-out.`);
						}
						return auth.state.localIdentity.keyring;
					},
				}),
			{ clientId },
		);

		const yjsLog = attachYjsLog(workspace.ydoc, {
			filePath: yjsPath(projectDir, workspace.ydoc.guid),
		});

		const collaboration = openCollaboration(workspace.ydoc, {
			url: roomWsUrl(EPICENTER_API_URL, workspace.ydoc.guid),
			openWebSocket: auth.openWebSocket,
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
