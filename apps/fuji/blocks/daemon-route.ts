import { EPICENTER_API_URL } from '@epicenter/constants/apps';
import {
	attachEncryption,
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
import * as Y from 'yjs';
import {
	createFujiActions,
	FUJI_WORKSPACE_ID,
	fujiTables,
} from './workspace.js';

export function defineFujiDaemon({ route = 'fuji' }: { route?: string } = {}) {
	return {
		route,
		async start({ auth, projectDir }) {
			if (auth.state.status === 'signed-out') {
				throw new Error('[fuji-daemon] auth signed-out at start.');
			}
			const ydoc = new Y.Doc({ guid: FUJI_WORKSPACE_ID, gc: false });
			ydoc.clientID = hashClientId(projectDir);
			const encryption = attachEncryption(ydoc, {
				keyring: () => {
					if (auth.state.status === 'signed-out') {
						throw new Error('[fuji-daemon] auth signed-out.');
					}
					return auth.state.localIdentity.keyring;
				},
			});
			const tables = encryption.attachTables(fujiTables);
			encryption.attachKv({});
			const yjsLog = attachYjsLog(ydoc, {
				filePath: yjsPath(projectDir, ydoc.guid),
			});
			const actions = createFujiActions(tables);
			const collaboration = openCollaboration(ydoc, {
				url: roomWsUrl(EPICENTER_API_URL, ydoc.guid),
				openWebSocket: auth.openWebSocket,
				replicaId: 'fuji-daemon',
				actions,
			});
			const sqliteDb = openWriterSqlite({
				filePath: sqlitePath(projectDir, ydoc.guid),
				log: createLogger('fuji-sqlite'),
			});
			ydoc.once('destroy', () => sqliteDb.close());
			attachSqliteMaterializer(ydoc, { db: sqliteDb }).table(tables.entries);
			attachMarkdownMaterializer(ydoc, {
				dir: markdownPath(projectDir, ydoc.guid),
			}).table(tables.entries, { filename: slugFilename('title') });

			return {
				collaboration,
				yjsLog,
				async [Symbol.asyncDispose]() {
					ydoc.destroy();
					await Promise.all([collaboration.whenDisposed, yjsLog.whenDisposed]);
				},
			};
		},
	} satisfies DaemonRouteDefinition;
}
