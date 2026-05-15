import { EPICENTER_API_URL } from '@epicenter/constants/apps';
import {
	attachEncryption,
	openCollaboration,
	roomWsUrl,
} from '@epicenter/workspace';
import type { DaemonRouteDefinition } from '@epicenter/workspace/daemon';
import { attachYjsLog, hashClientId, yjsPath } from '@epicenter/workspace/node';
import * as Y from 'yjs';
import { OPENSIDIAN_WORKSPACE_ID, opensidianTables } from './workspace.js';

export const DEFAULT_OPENSIDIAN_DAEMON_ROUTE = 'opensidian';

export function defineOpensidianDaemon({
	route = DEFAULT_OPENSIDIAN_DAEMON_ROUTE,
}: {
	route?: string;
} = {}) {
	return {
		route,
		async start({ auth, projectDir }) {
			if (auth.state.status === 'signed-out') {
				throw new Error('[opensidian-daemon] auth signed-out at start.');
			}
			const ydoc = new Y.Doc({ guid: OPENSIDIAN_WORKSPACE_ID, gc: false });
			ydoc.clientID = hashClientId(projectDir);
			const encryption = attachEncryption(ydoc, {
				keyring: () => {
					if (auth.state.status === 'signed-out') {
						throw new Error('[opensidian-daemon] auth signed-out.');
					}
					return auth.state.localIdentity.keyring;
				},
			});
			const tables = encryption.attachTables(opensidianTables);
			const kv = encryption.attachKv({});
			const yjsLog = attachYjsLog(ydoc, {
				filePath: yjsPath(projectDir, ydoc.guid),
			});

			// Daemon runtime is sync-only for now: no actions and no materializers.
			// Browser runtime owns Opensidian file and shell actions because they
			// need browser services.
			const collaboration = openCollaboration(ydoc, {
				url: roomWsUrl(EPICENTER_API_URL, ydoc.guid),
				openWebSocket: auth.openWebSocket,
				replicaId: 'opensidian-daemon',
				actions: {},
			});

			return {
				ydoc,
				tables,
				kv,
				batch: (fn: () => void) => ydoc.transact(fn),
				yjsLog,
				collaboration,
				async [Symbol.asyncDispose]() {
					ydoc.destroy();
					await Promise.all([collaboration.whenDisposed, yjsLog.whenDisposed]);
				},
			};
		},
	} satisfies DaemonRouteDefinition;
}
