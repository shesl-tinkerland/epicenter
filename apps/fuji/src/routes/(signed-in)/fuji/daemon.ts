import { createMachineAuthClient, requireSignedIn } from '@epicenter/auth/node';
import { EPICENTER_API_URL } from '@epicenter/constants/apps';
import {
	attachAwareness,
	attachSync,
	createRemoteClient,
	PeerIdentity,
	type ProjectDir,
	toWsUrl,
} from '@epicenter/workspace';
import type { DaemonRouteDefinition } from '@epicenter/workspace/daemon';
import {
	attachMarkdown,
	slugFilename,
} from '@epicenter/workspace/document/attach-markdown';
import { attachSqlite } from '@epicenter/workspace/document/attach-sqlite';
import {
	attachYjsLog,
	connectDaemonActions,
	hashClientId,
	markdownPath,
	sqlitePath,
	yjsPath,
} from '@epicenter/workspace/node';
import { openFuji as openFujiDoc } from './index.js';
import type { createFujiActions } from './workspace.js';

export const DEFAULT_FUJI_DAEMON_ROUTE = 'fuji';

export type FujiDaemonOptions = {
	route?: string;
};

export function defineFujiDaemon({
	route = DEFAULT_FUJI_DAEMON_ROUTE,
}: FujiDaemonOptions = {}): DaemonRouteDefinition {
	return {
		route,
		async start({ projectDir }) {
			const auth = await createMachineAuthClient();
			const doc = openFujiDoc({
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
						id: 'fuji-daemon',
						name: 'Fuji Daemon',
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
			attachSqlite(doc.ydoc, {
				filePath: sqlitePath(projectDir, doc.ydoc.guid),
			}).table(doc.tables.entries);
			attachMarkdown(doc.ydoc, {
				dir: markdownPath(projectDir, doc.ydoc.guid),
			}).table(doc.tables.entries, { filename: slugFilename('title') });

			return {
				actions: doc.actions,
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

export function connectFujiDaemonActions({
	route = DEFAULT_FUJI_DAEMON_ROUTE,
	projectDir,
}: {
	route?: string;
	projectDir?: ProjectDir;
} = {}) {
	return connectDaemonActions<ReturnType<typeof createFujiActions>>({
		route,
		projectDir,
	});
}
