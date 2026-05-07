import { createMachineAuthClient, requireSignedIn } from '@epicenter/auth/node';
import { EPICENTER_API_URL } from '@epicenter/constants/apps';
import {
	attachAwareness,
	attachSync,
	createRemoteClient,
	PeerIdentity,
	toWsUrl,
} from '@epicenter/workspace';
import type { DaemonRouteDefinition } from '@epicenter/workspace/daemon';
import { attachYjsLog, hashClientId, yjsPath } from '@epicenter/workspace/node';
import { openZhongwen as openZhongwenDoc } from './index.js';

export const DEFAULT_ZHONGWEN_DAEMON_ROUTE = 'zhongwen';

export type ZhongwenDaemonOptions = {
	route?: string;
};

export function defineZhongwenDaemon({
	route = DEFAULT_ZHONGWEN_DAEMON_ROUTE,
}: ZhongwenDaemonOptions = {}): DaemonRouteDefinition {
	return {
		route,
		async start({ projectDir }) {
			const auth = await createMachineAuthClient();
			const doc = openZhongwenDoc({
				clientID: hashClientId(projectDir),
				encryptionKeys: () => requireSignedIn(auth).encryptionKeys,
			});
			const yjsLog = attachYjsLog(doc.ydoc, {
				filePath: yjsPath(projectDir, doc.ydoc.guid),
			});
			const awareness = attachAwareness(doc.ydoc, {
				schema: { peer: PeerIdentity },
				initial: {
					peer: {
						id: 'zhongwen-daemon',
						name: 'Zhongwen Daemon',
						platform: 'node',
					},
				},
			});
			const sync = attachSync(doc, {
				url: toWsUrl(`${EPICENTER_API_URL}/workspaces/${doc.ydoc.guid}`),
				bearerToken: () => auth.bearerToken,
				awareness,
			});
			const actions = {};
			const rpc = sync.attachRpc(actions);
			const remote = createRemoteClient({ awareness, rpc });

			return {
				...doc,
				yjsLog,
				awareness,
				sync,
				remote,
				actions,
				async [Symbol.asyncDispose]() {
					doc[Symbol.dispose]();
					await Promise.all([sync.whenDisposed, yjsLog.whenDisposed]);
				},
			};
		},
	};
}
