/**
 * Daemon-side factory for the Zhongwen workspace.
 *
 * Wires the long-lived materializer worker: cloud sync over WebSocket plus
 * sole-writer SQLite persistence. Constructed once per `epicenter serve`
 * process. Materializer projections are not wired here; layer them on at
 * the consumer if needed.
 *
 * Pairs with `script.ts` and `browser.ts`.
 */

import { EPICENTER_API_URL } from '@epicenter/constants/apps';
import {
	attachSqlitePersistence,
	attachSync,
	type DeviceDescriptor,
	type ProjectDir,
	toWsUrl,
	yjsPath,
	type WebSocketImpl,
} from '@epicenter/workspace';
import { openZhongwen as openZhongwenDoc } from './core.js';

export function openZhongwen({
	getToken,
	device,
	projectDir,
	apiUrl = EPICENTER_API_URL,
	webSocketImpl,
}: {
	getToken: () => string | null | Promise<string | null>;
	/**
	 * Required: a long-lived materializer worker should always show up in
	 * awareness so peers can see "the daemon is up" and can RPC-route to it
	 * via `peer(workspace, deviceId)`. Mint via `getOrCreateDeviceId()` or
	 * read from `~/.epicenter/deviceId`.
	 */
	device: DeviceDescriptor;
	/**
	 * Project root (where `epicenter.config.ts` lives). Required: the daemon
	 * is the sole writer of `<projectDir>/.epicenter/yjs/<guid>.db`, so there
	 * is no sane fallback. Mint via `findEpicenterDir()` at the call site
	 * to brand a discovered path as `ProjectDir`.
	 */
	projectDir: ProjectDir;
	/**
	 * Epicenter API base URL. Defaults to `EPICENTER_API_URL` (production).
	 * Override for self-hosted instances, staging deployments, or
	 * integration tests routing to a local fake.
	 */
	apiUrl?: string;
	/**
	 * WebSocket constructor for `attachSync`. Tests pass a stub to avoid
	 * dialing real servers; production omits it (defaults to
	 * `globalThis.WebSocket`).
	 */
	webSocketImpl?: WebSocketImpl;
}) {
	const doc = openZhongwenDoc();

	const persistence = attachSqlitePersistence(doc.ydoc, {
		filePath: yjsPath(projectDir, doc.ydoc.guid),
	});

	const sync = attachSync(doc, {
		url: toWsUrl(`${apiUrl}/workspaces/${doc.ydoc.guid}`),
		waitFor: persistence.whenLoaded,
		device,
		getToken,
		webSocketImpl,
	});

	return {
		...doc,
		persistence,
		sync,
		/** Workspace `whenReady` convention: yjs file replayed into the Y.Doc. */
		whenReady: persistence.whenLoaded,
	};
}
