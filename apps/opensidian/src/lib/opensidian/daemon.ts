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
import { openOpensidian as openOpensidianDoc } from './index.js';

export const DEFAULT_OPENSIDIAN_DAEMON_ROUTE = 'opensidian';

export type OpensidianDaemonOptions = {
	route?: string;
};

export function defineOpensidianDaemon({
	route = DEFAULT_OPENSIDIAN_DAEMON_ROUTE,
}: OpensidianDaemonOptions = {}): DaemonRouteDefinition {
	return {
		route,
		async start({ projectDir }) {
			const auth = await createMachineAuthClient();
			const doc = openOpensidianDoc({
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
						id: 'opensidian-daemon',
						name: 'Opensidian Daemon',
						platform: 'node',
					},
				},
			});
			const sync = attachSync(doc, {
				url: toWsUrl(`${EPICENTER_API_URL}/workspaces/${doc.ydoc.guid}`),
				bearerToken: () => auth.bearerToken,
				awareness,
			});

			// Daemon runtime is materializer-only for now. Browser runtime owns
			// Opensidian file and shell actions because they need browser services.
			const actions = {};
			const rpc = sync.attachRpc(actions);
			const remote = createRemoteClient({ awareness, rpc });

			return {
				...doc,
				yjsLog,
				awareness,
				sync,
				actions,
				remote,
				async [Symbol.asyncDispose]() {
					doc[Symbol.dispose]();
					await Promise.all([sync.whenDisposed, yjsLog.whenDisposed]);
				},
			};
		},
	};
}
