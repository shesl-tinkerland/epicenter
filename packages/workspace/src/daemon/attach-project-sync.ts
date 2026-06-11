/**
 * Project-daemon durable sync for a single workspace doc.
 *
 * `attachProjectSync(ydoc, opts)` is the recipe every mount needs: persist the
 * Y.Doc update log to disk under `yjsPath(projectDir, guid)`, join the cloud
 * room at the partitioned `roomWsUrl({ baseURL, ownerId, guid, deviceId })`,
 * and expose the collaboration handle plus aggregate teardown barrier for the
 * attachments it constructs (collaboration + log).
 *
 * A cloud doc is owned by the authenticated `ownerId` and addressed by its
 * `ydoc.guid`. The daemon and browser apps build the same URL with
 * `roomWsUrl({ baseURL, ownerId, guid, deviceId })`, so syncing the same guid
 * for the same owner means sharing one room.
 *
 * The helper takes the ydoc and the mount-context capabilities directly so the
 * caller stays explicit about its `actions` choice: app workspaces with
 * browser-only actions pass `{}` to refuse them on the daemon side, while
 * workspaces with daemon-safe actions pass `workspace.actions`.
 *
 * Returns the part the host reads (`collaboration`) plus a mount-private
 * `whenDisposed` barrier. The opened mount owns `[Symbol.asyncDispose]`: it
 * destroys the workspace doc once, then awaits this barrier alongside any
 * sibling attachments it constructed around the same doc.
 */

import type { OwnerId } from '@epicenter/identity';
import type * as Y from 'yjs';

import { attachYjsLog } from '../document/attach-yjs-log.js';
import type { DeviceId } from '../document/device-id.js';
import {
	type OnReconnectSignal,
	type OpenWebSocketFn,
	openCollaboration,
} from '../document/open-collaboration.js';
import { roomWsUrl } from '../document/transport.js';
import { yjsPath } from '../document/workspace-paths.js';
import type { ActionRegistry } from '../shared/actions.js';
import type { ProjectDir } from '../shared/types.js';

export type AttachProjectSyncOptions<TActions extends ActionRegistry> = {
	projectDir: ProjectDir;
	ownerId: OwnerId;
	deviceId: DeviceId;
	openWebSocket: OpenWebSocketFn;
	onReconnectSignal: OnReconnectSignal;
	actions: TActions;
	/** Base URL of the sync server (the Epicenter cloud, or a self-hosted hub). */
	baseURL: string;
};

export function attachProjectSync<TActions extends ActionRegistry>(
	ydoc: Y.Doc,
	{
		projectDir,
		ownerId,
		deviceId,
		openWebSocket,
		onReconnectSignal,
		actions,
		baseURL,
	}: AttachProjectSyncOptions<TActions>,
) {
	const yjsLog = attachYjsLog(ydoc, {
		filePath: yjsPath(projectDir, ydoc.guid),
	});

	const collaboration = openCollaboration(ydoc, {
		url: roomWsUrl({
			baseURL,
			ownerId,
			guid: ydoc.guid,
			deviceId,
		}),
		openWebSocket,
		onReconnectSignal,
		actions,
	});

	return {
		/** Cloud sync, presence, and dispatch handle for this mount. */
		collaboration,
		/**
		 * Resolves after the Y.Doc destroy cascade disposes the collaboration
		 * transport and local update log. The mount awaits this with its sibling
		 * attachment barriers before process exit.
		 */
		whenDisposed: Promise.all([
			collaboration.whenDisposed,
			yjsLog.whenDisposed,
		]).then(() => undefined),
	};
}

export type ProjectSyncAttachment<TActions extends ActionRegistry> = ReturnType<
	typeof attachProjectSync<TActions>
>;
