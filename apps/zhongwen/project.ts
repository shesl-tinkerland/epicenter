/**
 * Zhongwen project mount.
 *
 * `zhongwen()` returns the `Mount` that a project's `epicenter.config.ts`
 * default-exports. Zhongwen has no daemon actions and no materializers today;
 * the daemon's only job is to host the encrypted Y.Doc on disk and bridge
 * sync.
 */

import { EPICENTER_API_URL } from '@epicenter/constants/apps';
import { defineWorkspace } from '@epicenter/workspace';
import { defineMount } from '@epicenter/workspace/daemon';
import { attachProjectSync } from '@epicenter/workspace/node';
import { createZhongwen } from './zhongwen.js';

export function zhongwen() {
	return defineMount({
		name: 'zhongwen',
		open(ctx) {
			const workspace = createZhongwen({ keyring: ctx.keyring });
			workspace.ydoc.clientID = ctx.yDocClientId;

			const sync = attachProjectSync(workspace.ydoc, {
				baseURL: EPICENTER_API_URL,
				projectDir: ctx.projectDir,
				ownerId: ctx.ownerId,
				deviceId: ctx.deviceId,
				openWebSocket: ctx.openWebSocket,
				onReconnectSignal: ctx.onReconnectSignal,
				actions: workspace.actions,
			});

			return defineWorkspace({
				...workspace,
				collaboration: sync.collaboration,
				async [Symbol.asyncDispose]() {
					workspace[Symbol.dispose]();
					await sync.whenDisposed;
				},
			});
		},
	});
}

export type ZhongwenMount = ReturnType<typeof zhongwen>;
