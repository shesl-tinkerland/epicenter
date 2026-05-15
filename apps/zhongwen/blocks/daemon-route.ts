import { EPICENTER_API_URL } from '@epicenter/constants/apps';
import {
	attachEncryption,
	openCollaboration,
	roomWsUrl,
} from '@epicenter/workspace';
import type { DaemonRouteDefinition } from '@epicenter/workspace/daemon';
import { attachYjsLog, hashClientId, yjsPath } from '@epicenter/workspace/node';
import * as Y from 'yjs';
import {
	ZHONGWEN_WORKSPACE_ID,
	zhongwenKv,
	zhongwenTables,
} from './workspace.js';

export const DEFAULT_ZHONGWEN_DAEMON_ROUTE = 'zhongwen';

export function defineZhongwenDaemon({
	route = DEFAULT_ZHONGWEN_DAEMON_ROUTE,
}: {
	route?: string;
} = {}) {
	return {
		route,
		async start({ auth, projectDir }) {
			if (auth.state.status === 'signed-out') {
				throw new Error('[zhongwen-daemon] auth signed-out at start.');
			}
			const ydoc = new Y.Doc({ guid: ZHONGWEN_WORKSPACE_ID, gc: false });
			ydoc.clientID = hashClientId(projectDir);
			const encryption = attachEncryption(ydoc, {
				keyring: () => {
					if (auth.state.status === 'signed-out') {
						throw new Error('[zhongwen-daemon] auth signed-out.');
					}
					return auth.state.localIdentity.keyring;
				},
			});
			const tables = encryption.attachTables(zhongwenTables);
			const kv = encryption.attachKv(zhongwenKv);
			const yjsLog = attachYjsLog(ydoc, {
				filePath: yjsPath(projectDir, ydoc.guid),
			});
			const collaboration = openCollaboration(ydoc, {
				url: roomWsUrl(EPICENTER_API_URL, ydoc.guid),
				openWebSocket: auth.openWebSocket,
				replicaId: 'zhongwen-daemon',
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
