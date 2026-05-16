/**
 * Zhongwen daemon extension entrypoint.
 *
 * Opens the shared Zhongwen workspace in a node runtime, persists the Yjs log,
 * and joins sync as a daemon peer. The current extension exposes no daemon
 * actions.
 *
 * Folder-routed daemon extension contract: the host passes the encryption
 * attacher and WebSocket factory in via the context, so this body only
 * composes daemon-side runtime around `openZhongwenWorkspace`.
 */

import { EPICENTER_API_URL } from '@epicenter/constants/apps';
import { openCollaboration, roomWsUrl } from '@epicenter/workspace';
import { defineDaemonWorkspace } from '@epicenter/workspace/daemon';
import { attachYjsLog, yjsPath } from '@epicenter/workspace/node';
import { openZhongwenWorkspace } from './workspace.js';

export default defineDaemonWorkspace({
	async open({
		projectDir,
		clientId,
		replicaId,
		attachEncryption,
		openWebSocket,
	}) {
		const workspace = openZhongwenWorkspace(attachEncryption, { clientId });

		const yjsLog = attachYjsLog(workspace.ydoc, {
			filePath: yjsPath(projectDir, workspace.ydoc.guid),
		});

		const collaboration = openCollaboration(workspace.ydoc, {
			url: roomWsUrl(EPICENTER_API_URL, workspace.ydoc.guid),
			openWebSocket,
			replicaId,
			actions: {},
		});

		return {
			...workspace,
			yjsLog,
			collaboration,
			async [Symbol.asyncDispose]() {
				workspace.ydoc.destroy();
				await Promise.all([collaboration.whenDisposed, yjsLog.whenDisposed]);
			},
		};
	},
});
