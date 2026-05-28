/**
 * Opensidian project mount.
 *
 * `opensidian()` returns the `Mount` that a project's `epicenter.config.ts`
 * default-exports.
 *
 * The shared workspace currently exposes no daemon actions. Opensidian's file
 * and shell actions need browser services (Yjs filesystem, in-browser SQLite,
 * just-bash) and are added only by the browser runtime.
 */

import { defineWorkspace } from '@epicenter/workspace';
import { defineMount } from '@epicenter/workspace/daemon';
import { attachProjectInfrastructure } from '@epicenter/workspace/node';
import { createOpensidianWorkspace } from './opensidian.js';

export function opensidian() {
	return defineMount({
		name: 'opensidian',
		open(ctx) {
			const workspace = createOpensidianWorkspace({ keyring: ctx.keyring });
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

export type OpensidianMount = ReturnType<typeof opensidian>;
