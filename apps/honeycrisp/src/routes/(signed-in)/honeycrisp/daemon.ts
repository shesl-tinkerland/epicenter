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
import { openHoneycrisp as openHoneycrispDoc } from './index.js';

export const DEFAULT_HONEYCRISP_DAEMON_ROUTE = 'honeycrisp';

export type HoneycrispDaemonOptions = {
	route?: string;
};

export function defineHoneycrispDaemon({
	route = DEFAULT_HONEYCRISP_DAEMON_ROUTE,
}: HoneycrispDaemonOptions = {}): DaemonRouteDefinition {
	return {
		route,
		async start({ projectDir }) {
			const auth = await createMachineAuthClient();
			const doc = openHoneycrispDoc({
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
						id: 'honeycrisp-daemon',
						name: 'Honeycrisp Daemon',
						platform: 'node',
					},
				},
			});
			const sync = attachSync(doc, {
				url: toWsUrl(`${EPICENTER_API_URL}/workspaces/${doc.ydoc.guid}`),
				bearerToken: () => auth.bearerToken,
				awareness,
			});
			const rpc = sync.attachRpc(doc.actions);
			const remote = createRemoteClient({ awareness, rpc });

			return {
				...doc,
				yjsLog,
				awareness,
				sync,
				remote,
				async [Symbol.asyncDispose]() {
					doc[Symbol.dispose]();
					await Promise.all([sync.whenDisposed, yjsLog.whenDisposed]);
				},
			};
		},
	};
}
