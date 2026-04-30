/**
 * Daemon-side factory for the Opensidian workspace.
 *
 * Wires the long-lived materializer worker: cloud sync over WebSocket plus
 * sole-writer SQLite persistence. Constructed once per `epicenter serve`
 * process. SQLite/markdown materializer projections are intentionally not
 * wired here; they need per-file content docs (see
 * `playground/opensidian-e2e/epicenter.config.ts` for the full composition)
 * which a single one-line factory can't capture.
 *
 * Pairs with `script.ts` (short-lived peers that read this daemon's yjs
 * file and sync via cloud) and `browser.ts` (Svelte UI).
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
import { openOpensidian as openOpensidianDoc } from './index.js';

export function openOpensidian({
	getToken,
	device,
	projectDir,
	webSocketImpl,
}: {
	getToken: () => string | null | Promise<string | null>;
	device?: DeviceDescriptor;
	/**
	 * Project root (where `epicenter.config.ts` lives). Required: the daemon
	 * is the sole writer of `<projectDir>/.epicenter/yjs/<guid>.db`, so there
	 * is no sane fallback. Mint via `findEpicenterDir()` at the call site
	 * to brand a discovered path as `ProjectDir`.
	 */
	projectDir: ProjectDir;
	/**
	 * WebSocket constructor for `attachSync`. Tests pass a stub to avoid
	 * dialing real servers; production omits it (defaults to
	 * `globalThis.WebSocket`).
	 */
	webSocketImpl?: WebSocketImpl;
}) {
	const doc = openOpensidianDoc();

	const persistence = attachSqlitePersistence(doc.ydoc, {
		filePath: yjsPath(projectDir, doc.ydoc.guid),
	});

	const sync = attachSync(doc, {
		url: toWsUrl(`${EPICENTER_API_URL}/workspaces/${doc.ydoc.guid}`),
		waitFor: persistence.whenLoaded,
		device,
		getToken,
		webSocketImpl,
	});

	return {
		...doc,
		persistence,
		sync,
		/**
		 * Resolves once the daemon's yjs file has replayed into the Y.Doc:
		 * the durable state is in memory and writes are safe. Does NOT
		 * gate the cloud WS handshake. Compose with `sync.whenConnected` for
		 * "fully online before proceeding."
		 */
		whenReady: persistence.whenLoaded,
	};
}
