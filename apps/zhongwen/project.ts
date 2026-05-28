/**
 * Zhongwen project mount.
 *
 * `zhongwen()` returns the `Mount` that a project's `epicenter.config.ts`
 * default-exports. Zhongwen has no daemon actions and no materializers today;
 * the daemon's only job is to host the encrypted Y.Doc on disk and bridge
 * sync.
 */

import { defineWorkspace } from '@epicenter/workspace';
import { defineMount } from '@epicenter/workspace/daemon';
import { attachProjectInfrastructure } from '@epicenter/workspace/node';
import { createZhongwenWorkspace } from './zhongwen.js';

export function zhongwen() {
	return defineMount({
		name: 'zhongwen',
		open(ctx) {
			const workspace = createZhongwenWorkspace({ keyring: ctx.keyring });
			workspace.ydoc.clientID = ctx.yDocClientId;

			const infrastructure = attachProjectInfrastructure(workspace.ydoc, {
				projectDir: ctx.projectDir,
				ownerId: ctx.ownerId,
				deviceId: ctx.deviceId,
				openWebSocket: ctx.openWebSocket,
				onReconnectSignal: ctx.onReconnectSignal,
				actions: workspace.actions,
			});

			return defineWorkspace({
				...workspace,
				...infrastructure,
			});
		},
	});
}

export type ZhongwenMount = ReturnType<typeof zhongwen>;
