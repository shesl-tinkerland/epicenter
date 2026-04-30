/**
 * Daemon-side factory for the Fuji workspace.
 *
 * Wires the long-lived materializer worker: cloud sync over WebSocket plus
 * sole-writer SQLite persistence (the yjs update log) plus SQLite +
 * markdown materializer projections. Constructed once per `epicenter
 * serve` process.
 *
 * Pairs with `script.ts` (short-lived peers that read this daemon's yjs
 * file and sync via cloud) and `browser.ts` (Svelte UI).
 */

import { EPICENTER_API_URL } from '@epicenter/constants/apps';
import {
	attachSqlitePersistence,
	attachSync,
	type DeviceDescriptor,
	markdownPath,
	type ProjectDir,
	sqlitePath,
	toWsUrl,
	yjsPath,
	type WebSocketImpl,
} from '@epicenter/workspace';
import { attachMarkdownMaterializer } from '@epicenter/workspace/document/materializer/markdown';
import { attachSqliteMaterializer } from '@epicenter/workspace/document/materializer/sqlite';
import { openFuji as openFujiDoc } from './index.js';

export function openFuji({
	getToken,
	device,
	absDir,
	webSocketImpl,
}: {
	getToken: () => string | null | Promise<string | null>;
	device?: DeviceDescriptor;
	/**
	 * Project root (where `epicenter.config.ts` lives). Required: the daemon
	 * is the sole writer of `<absDir>/.epicenter/yjs/<guid>.db`, so there
	 * is no sane fallback. Mint via `findEpicenterDir()` at the call site
	 * to brand a discovered path as `ProjectDir`.
	 */
	absDir: ProjectDir;
	/**
	 * WebSocket constructor for `attachSync`. Tests pass a stub to avoid
	 * dialing real servers; production omits it (defaults to
	 * `globalThis.WebSocket`).
	 */
	webSocketImpl?: WebSocketImpl;
}) {
	const doc = openFujiDoc();

	const persistence = attachSqlitePersistence(doc.ydoc, {
		filePath: yjsPath(absDir, doc.ydoc.guid),
	});

	const sync = attachSync(doc, {
		url: toWsUrl(`${EPICENTER_API_URL}/workspaces/${doc.ydoc.guid}`),
		waitFor: persistence.whenLoaded,
		device,
		getToken,
		webSocketImpl,
	});

	const sqlite = attachSqliteMaterializer(doc.ydoc, {
		filePath: sqlitePath(absDir, doc.ydoc.guid),
		waitFor: persistence.whenLoaded,
	}).table(doc.tables.entries);

	const markdown = attachMarkdownMaterializer(doc.ydoc, {
		dir: markdownPath(absDir, doc.ydoc.guid),
		waitFor: persistence.whenLoaded,
	});

	return {
		...doc,
		persistence,
		sync,
		sqlite,
		markdown,
		/**
		 * Resolves once the daemon's yjs file has replayed into the Y.Doc:
		 * the durable state is in memory and writes are safe. Does NOT
		 * gate the materializers' initial flush (they `waitFor` the same
		 * signal but their first row writes happen after this resolves) or
		 * the cloud WS handshake (offline-tolerant by design). Compose with
		 * `sync.whenConnected` if you need "fully online before proceeding."
		 */
		whenReady: persistence.whenLoaded,
	};
}
