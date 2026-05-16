/**
 * Fuji daemon runtime entrypoint.
 *
 * Composes daemon-only attachments (Yjs log, collaboration, SQLite materializer,
 * Markdown materializer, CLI/script actions) around the shared
 * `openFujiWorkspace(owner)` opener. The browser composes browser-only
 * attachments around the same opener.
 *
 * Wave 1 still publishes through the existing `DaemonRouteDefinition` shape so
 * the current daemon host can import this file. Phase 1 of the folder-routed
 * spec swaps it for `defineDaemonWorkspace({ open })`.
 */

import { EPICENTER_API_URL } from '@epicenter/constants/apps';
import {
	attachEncryption,
	type LocalOwner,
	openCollaboration,
	roomWsUrl,
} from '@epicenter/workspace';
import type { DaemonRouteDefinition } from '@epicenter/workspace/daemon';
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
import { createFujiActions, openFujiWorkspace } from './workspace.js';

export function defineFujiDaemon({ route = 'fuji' }: { route?: string } = {}) {
	return {
		route,
		async start({ auth, projectDir }) {
			if (auth.state.status === 'signed-out') {
				throw new Error('[fuji-daemon] auth signed-out at start.');
			}

			const owner: Pick<LocalOwner, 'attachEncryption'> = {
				attachEncryption(ydoc) {
					return attachEncryption(ydoc, {
						keyring: () => {
							if (auth.state.status === 'signed-out') {
								throw new Error('[fuji-daemon] auth signed-out.');
							}
							return auth.state.localIdentity.keyring;
						},
					});
				},
			};

			const workspace = openFujiWorkspace(owner, {
				clientId: hashClientId(projectDir),
			});
			const actions = createFujiActions(workspace.tables);

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
				log: createLogger('fuji-sqlite'),
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
	} satisfies DaemonRouteDefinition;
}
