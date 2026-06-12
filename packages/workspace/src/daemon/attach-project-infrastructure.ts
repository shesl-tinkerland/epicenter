/**
 * Project-daemon persistence + sync infrastructure for a single workspace doc.
 *
 * `attachProjectInfrastructure(ydoc, opts)` is the recipe every mount needs:
 * persist the Y.Doc update log to disk under `yjsPath(projectDir, guid)`, join
 * the cloud room at the partitioned `roomWsUrl({ baseURL, ownerId, guid,
 * deviceId })`, and own the ordered async dispose (destroy first so writes
 * flush before sockets close, then await every `whenDisposed` barrier:
 * collaboration, log, and any registered materializers).
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
 * Returns the parts the host reads (`collaboration`) plus the side-effectful
 * `yjsLog` handle and an `[Symbol.asyncDispose]` that encodes the destroy
 * order. Callers usually spread the result into their `DaemonRuntime` and
 * compose materializers around the same ydoc.
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

export type AttachProjectInfrastructureOptions<
	TActions extends ActionRegistry,
> = {
	projectDir: ProjectDir;
	ownerId: OwnerId;
	deviceId: DeviceId;
	openWebSocket: OpenWebSocketFn;
	onReconnectSignal: OnReconnectSignal;
	actions: TActions;
	/** Base URL of the sync server (the Epicenter cloud, or a self-hosted hub). */
	baseURL: string;
	/**
	 * Materializer attachments composed around the same ydoc. Their teardown
	 * drains are awaited alongside collaboration and log teardown, so a daemon
	 * shutdown cannot drop projection writes mid-flight. Each drain is bounded
	 * by the materializer's own `disposeTimeoutMs`.
	 */
	materializers?: ReadonlyArray<{ whenDisposed: Promise<void> }>;
};

export function attachProjectInfrastructure<TActions extends ActionRegistry>(
	ydoc: Y.Doc,
	{
		projectDir,
		ownerId,
		deviceId,
		openWebSocket,
		onReconnectSignal,
		actions,
		baseURL,
		materializers = [],
	}: AttachProjectInfrastructureOptions<TActions>,
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
		/** Durable Y.Doc update log handle. */
		yjsLog,
		/** Cloud sync, presence, and dispatch handle for this mount. */
		collaboration,
		/**
		 * Destroy the Y.Doc, then await collaboration, log, and materializer
		 * teardown (each materializer drains its pending projection writes).
		 */
		async [Symbol.asyncDispose]() {
			ydoc.destroy();
			await Promise.all([
				collaboration.whenDisposed,
				yjsLog.whenDisposed,
				...materializers.map((materializer) => materializer.whenDisposed),
			]);
		},
	};
}

export type ProjectInfrastructure<TActions extends ActionRegistry> = ReturnType<
	typeof attachProjectInfrastructure<TActions>
>;
