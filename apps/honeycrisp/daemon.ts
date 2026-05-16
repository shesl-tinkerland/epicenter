/**
 * Honeycrisp daemon extension entrypoint.
 *
 * Composes daemon-only attachments (Yjs log, collaboration, SQLite materializer,
 * Markdown materializer) around the shared
 * `openHoneycrispWorkspace(attachEncryption)` opener. The browser composes
 * browser-only attachments around the same opener.
 *
 * Folder-routed daemon extension contract: the default export is a
 * `DaemonWorkspaceModule` whose `open(ctx)` receives the shared auth client,
 * the resolved project directory, and the folder-derived route from the host.
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
	hashClientId,
	markdownPath,
	openWriterSqlite,
	sqlitePath,
	yjsPath,
} from '@epicenter/workspace/node';
import { createLogger } from 'wellcrafted/logger';
import {
	createHoneycrispActions,
	openHoneycrispWorkspace,
} from './workspace.js';

export default defineDaemonWorkspace({
	async open({ auth, projectDir, route }) {
		if (auth.state.status === 'signed-out') {
			throw new Error(`[${route}-daemon] auth signed-out at start.`);
		}

		const workspace = openHoneycrispWorkspace(
			(ydoc) =>
				attachEncryption(ydoc, {
					keyring: () => {
						if (auth.state.status === 'signed-out') {
							throw new Error(`[${route}-daemon] auth signed-out.`);
						}
						return auth.state.localIdentity.keyring;
					},
				}),
			{ clientId: hashClientId(projectDir) },
		);
		const actions = createHoneycrispActions(workspace.tables);

		const yjsLog = attachYjsLog(workspace.ydoc, {
			filePath: yjsPath(projectDir, workspace.ydoc.guid),
		});

		const collaboration = openCollaboration(workspace.ydoc, {
			url: roomWsUrl(EPICENTER_API_URL, workspace.ydoc.guid),
			openWebSocket: auth.openWebSocket,
			replicaId: `${route}-daemon`,
			actions,
		});

		const sqliteDb = openWriterSqlite({
			filePath: sqlitePath(projectDir, workspace.ydoc.guid),
			log: createLogger(`${route}-sqlite`),
		});
		workspace.ydoc.once('destroy', () => sqliteDb.close());

		const sqlite = attachSqliteMaterializer(workspace.ydoc, { db: sqliteDb });
		sqlite.table(workspace.tables.folders);
		sqlite.table(workspace.tables.notes);

		attachMarkdownMaterializer(workspace.ydoc, {
			dir: markdownPath(projectDir, workspace.ydoc.guid),
		}).table(workspace.tables.notes, { filename: slugFilename('title') });

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
